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
import type { RunRecord, TicketRecord } from "../state/run-record.js";
import {
  assertSealedModelAdmission,
  describeRoleModelSubstitutions,
  loadSealedPiModelCatalog,
  resolveRoleModelSelections,
  sealPiModelDescriptor,
} from "../pi/model-catalog.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CompilerDiagnostic } from "../shared/diagnostics.js";
import {
  loadCachedInstalledProfile,
  type InstalledProfileReference,
  readInstalledProfileReference,
} from "./profile-source.js";
import { loadProfilePackage } from "../profile/install.js";
import { PiAttemptProcessSupervisor } from "../pi/attempt-process-pool.js";
import {
  loadPiResolvedInventory,
  piAgentCatalogFromCompiledConfiguration,
  resolvePiAgentConfiguration,
  type ResolvedPiAgentConfiguration,
} from "../pi/agent-configuration.js";
import { resolveCompiledAgent } from "../compiler/resolution.js";
import {
  assertRuntimeClosureCurrent,
  assertRuntimeClosureFromEnvironment,
  captureRuntimeClosure,
  KONI_RUNTIME_CLOSURE_ENV,
  KONI_RUNTIME_PIN_PATH_ENV,
  KONI_RUNTIME_PIN_SHA256_ENV,
  persistRuntimeClosurePin,
  runtimeExecutable,
} from "../runtime/identity.js";
import { pinAuthorityGitExecutable } from "../git/client.js";
import { resolvePiPeerRuntime } from "../runtime/pi-peer-runtime.js";
import {
  activeInstallationEnvironment,
  activeInstallationFromEnvironment,
  assertActiveInstallationCurrent,
  bindVersionedActiveInstallation,
  type ActiveInstallationBinding,
  waitForActiveInstallationSupersession,
} from "../runtime/active-installation.js";

// A first launch from an exact packed Pi installation has to materialize and verify the complete
// content-addressed runtime stage before the authority may bind its socket. Cold filesystems and
// package-manager layouts can make that honest security work take longer than a minute even
// though the daemon is healthy. A child exit cannot prove global startup failure because that
// child may have lost the lease to a concurrent winner that has not bound its socket yet.
const DEFAULT_START_TIMEOUT_MS = 120_000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;

export interface EnsureAuthorityOptions {
  projectRoot: string;
  version: string;
  client: ProtocolHandshake["client"];
  timeoutMs?: number;
  launch?: AuthorityDaemonLauncher;
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
  /** Exact number of runs settled to paused by the quiesce operation. */
  pausedRunCount: number;
  /** Bounded compatibility sample; use pausedRunCount for operator totals. */
  pausedRunIds: readonly string[];
  pausedRunIdsTruncated: boolean;
}

export async function stopAuthorityWhenInstallationSuperseded(
  options: {
    binding: ActiveInstallationBinding;
    projectRoot: string;
    version: string;
    pollIntervalMs?: number;
    retryIntervalMs?: number;
    signal?: AbortSignal;
  },
  dependencies: { stop?: typeof stopProjectAuthority } = {},
): Promise<ProjectAuthorityStopResult> {
  await waitForActiveInstallationSupersession(options.binding, {
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const retryIntervalMs = options.retryIntervalMs ?? 250;
  if (!Number.isSafeInteger(retryIntervalMs) || retryIntervalMs < 1) {
    throw new RangeError("upgrade handoff retry interval must be a positive integer");
  }
  while (true) {
    if (options.signal?.aborted === true) {
      throw new DOMException("active installation handoff aborted", "AbortError");
    }
    try {
      return await (dependencies.stop ?? stopProjectAuthority)({
        projectRoot: options.projectRoot,
        version: options.version,
      });
    } catch (error) {
      if (!isRetryableAuthorityStop(error)) throw error;
      await wait(retryIntervalMs);
    }
  }
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

export interface ProjectAgentResolution {
  readonly projectRoot: string;
  readonly runTypeId?: string;
  readonly agent: ResolvedPiAgentConfiguration;
  readonly effectiveModel?: Readonly<{
    provider: string;
    id: string;
    thinkingLevel: string;
  }>;
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
export async function ensureProjectAuthority(
  options: EnsureAuthorityOptions,
): Promise<AuthorityClient> {
  // Authenticate the active Pi + TypeBox host before even reusing an existing authority. A Pi
  // upgrade must therefore fail identically in `/koni`, `koni run`, and standalone operation.
  await resolvePiPeerRuntime();
  const endpoint = await discoverAuthorityEndpoint(options.projectRoot);
  const projectRoot = endpoint.identity.worktreeRoot;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS);
  let delay = 25;
  let launch: AuthorityDaemonLaunch | undefined;
  let launchAttempted = false;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let lastProbeStatus: "ready" | "starting" | "absent" = "absent";
  while (Date.now() < deadline) {
    const probe = await probeAuthority(options);
    lastProbeStatus = probe.status;
    if (probe.status === "ready") return probe.client;
    if (probe.status === "starting") {
      // A concurrent cold starter may have won the lease while this caller's child lost it and
      // exited. Keep polling the observed lease holder; never launch a duplicate or blame the
      // losing child while an authority is demonstrably recovering.
    } else if (!launchAttempted) {
      // Loading the cache before spawning gives the operator an immediate, actionable error and
      // prevents a detached process from treating mutable install metadata as package authority.
      await loadCachedInstalledProfile(projectRoot);
      launchAttempted = true;
      launch = await (options.launch ?? launchAuthorityDaemon)({
        projectRoot,
        version: options.version,
      });
      launch.exited
        ?.then((value) => {
          exit = value;
        })
        .catch(() => undefined);
    }
    await wait(delay);
    delay = Math.min(400, delay * 2);
  }
  if (exit !== undefined && lastProbeStatus === "absent") {
    throw new AuthorityBootstrapError(
      "authority_start_failed",
      `Koni authority exited and no concurrent authority became reachable before the startup deadline ` +
        `(code ${String(exit.code)}, signal ${String(exit.signal)})`,
    );
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
  const profile = await readInstalledProfileReference(endpoint.identity.worktreeRoot).catch(
    () => undefined,
  );
  const probe = await probeAuthority({ ...options, client: "cli", connectTimeoutMs: 500 });
  if (probe.status === "absent") {
    return {
      running: false,
      projectRoot: endpoint.identity.worktreeRoot,
      commonDirectory: endpoint.identity.commonDirectory,
      stateRoot: endpoint.stateRoot,
      endpoint: endpoint.endpoint,
      ...(profile === undefined ? {} : { profile }),
    };
  }
  if (probe.status === "starting") {
    return {
      running: true,
      projectRoot: endpoint.identity.worktreeRoot,
      commonDirectory: endpoint.identity.commonDirectory,
      stateRoot: endpoint.stateRoot,
      endpoint: endpoint.endpoint,
      ...(profile === undefined ? {} : { profile }),
    };
  }
  const client = probe.client;
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
        pausedRunCount: 0,
        pausedRunIds: [],
        pausedRunIdsTruncated: false,
      };
    }
    throw error;
  }

  let quiesce: ParsedQuiesceResult;
  try {
    const response = await client.request("authority.quiesce", undefined, {
      expectedRevision: client.revision,
      idempotencyKey: `operator-authority-quiesce:${randomUUID()}`,
    });
    quiesce = parseQuiesceResult(response);
  } finally {
    client.close();
  }

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
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
          ...quiesce,
        };
      }
      throw error;
    }
    await wait(25);
  }
  throw new AuthorityBootstrapError(
    "authority_stop_timeout",
    `Koni authority did not stop within ${options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS}ms`,
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

/** Resolve one agent against the same Pi repository inventory used for future runs. */
export async function resolveProjectAgentConfiguration(options: {
  projectRoot: string;
  agentId: string;
  runTypeId?: string;
}): Promise<ProjectAgentResolution> {
  const endpoint = await discoverAuthorityEndpoint(options.projectRoot);
  const cached = await loadCachedInstalledProfile(endpoint.identity.worktreeRoot);
  const baseline = await loadProfilePackage(cached.packageRoot);
  const compiled = await compileProjectDirectory(endpoint.identity.worktreeRoot, baseline);
  if (!compiled.ok) {
    throw new AuthorityBootstrapError(
      "configuration_invalid",
      compiled.diagnostics
        .map(({ code, path: diagnosticPath, message }) => `${code} ${diagnosticPath}: ${message}`)
        .join("\n"),
    );
  }
  const inventory = await loadPiResolvedInventory({
    projectRoot: endpoint.identity.worktreeRoot,
    installMissingPackages: process.env.NODE_ENV !== "test",
    skipMissingPackages: process.env.NODE_ENV === "test",
  });
  const resolved = resolvePiAgentConfiguration({
    agentId: options.agentId,
    agents: piAgentCatalogFromCompiledConfiguration(compiled.value),
    inventory,
    extensionAdapters: {},
  });
  if (!resolved.ok) {
    throw new AuthorityBootstrapError(
      "agent_invalid",
      resolved.diagnostics
        .map(({ code, path: diagnosticPath, message }) => `${code} ${diagnosticPath}: ${message}`)
        .join("\n"),
    );
  }
  const effective = resolveCompiledAgent(compiled.value, options.agentId, {
    ...(options.runTypeId === undefined ? {} : { runTypeId: options.runTypeId }),
  });
  if (!effective.ok) {
    throw new AuthorityBootstrapError(
      "agent_invalid",
      effective.diagnostics
        .map(({ code, path: diagnosticPath, message }) => `${code} ${diagnosticPath}: ${message}`)
        .join("\n"),
    );
  }
  const provider = effective.value.provider;
  const model = effective.value.model;
  const thinkingLevel = effective.value.thinking_level;
  return {
    projectRoot: endpoint.identity.worktreeRoot,
    ...(options.runTypeId === undefined ? {} : { runTypeId: options.runTypeId }),
    agent: resolved.value,
    ...(provider === undefined || model === undefined || thinkingLevel === undefined
      ? {}
      : { effectiveModel: { provider, id: model, thinkingLevel } }),
  };
}

/** Internal foreground entry used only by the detached `koni authority serve` child. */
export async function serveProjectAuthority(options: {
  projectRoot: string;
  version: string;
  shutdown?: Promise<void>;
  /** Daemon binding supplied by the authenticated launcher environment. */
  activeInstallation?: ActiveInstallationBinding;
  /**
   * Provider-free packaged-release evidence only: construct the exact production Pi child and
   * persist its session mapping, but require the test to pause/delete it before activation.
   */
  providerFreeAdmissionProbe?: true;
}): Promise<void> {
  const activeInstallation =
    options.activeInstallation ?? activeInstallationFromEnvironment(process.env);
  if (activeInstallation !== undefined) {
    await assertActiveInstallationCurrent(activeInstallation);
  }
  const parentRuntimeClosure = await assertRuntimeClosureFromEnvironment(import.meta.url);
  const piPeerRuntime = await resolvePiPeerRuntime();
  const runtimeClosure = await captureRuntimeClosure(import.meta.url, piPeerRuntime.packageRoot);
  if (runtimeClosure.closureSha256 !== parentRuntimeClosure.closureSha256) {
    throw new AuthorityBootstrapError(
      "authority_runtime_stage_drift",
      "staged authority runtime differs from the parent-authenticated closure",
    );
  }
  const gitExecutable = runtimeExecutable(runtimeClosure, "git");
  await pinAuthorityGitExecutable(gitExecutable);
  const endpoint = await discoverAuthorityEndpoint(options.projectRoot);
  const runtimeClosurePin = await persistRuntimeClosurePin(endpoint.stateRoot, runtimeClosure);
  const runtimeGuard = async () => {
    await assertRuntimeClosureCurrent(runtimeClosure);
    if (activeInstallation !== undefined) {
      await assertActiveInstallationCurrent(activeInstallation);
    }
  };
  const cached = await loadCachedInstalledProfile(endpoint.identity.worktreeRoot);
  const baseline = await loadProfilePackage(cached.packageRoot);
  const program = await NativeRunCompilerProgram.create({
    projectRoot: endpoint.identity.worktreeRoot,
    packageBaseline: baseline,
    packageBaselineLoader: async () => {
      const current = await loadCachedInstalledProfile(endpoint.identity.worktreeRoot);
      return loadProfilePackage(current.packageRoot);
    },
    ...(options.providerFreeAdmissionProbe === true
      ? { sealedModelBindingLoader: loadProviderFreeTestModelBinding }
      : {}),
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
  const activeInstallationMonitor = new AbortController();
  const upgradeHandoff =
    activeInstallation === undefined
      ? undefined
      : stopAuthorityWhenInstallationSuperseded({
          binding: activeInstallation,
          projectRoot: endpoint.identity.worktreeRoot,
          version: options.version,
          signal: activeInstallationMonitor.signal,
        });
  try {
    await Promise.race([
      options.shutdown ?? processShutdown(),
      requestedShutdown.promise,
      ...(upgradeHandoff === undefined ? [] : [upgradeHandoff]),
    ]);
  } finally {
    activeInstallationMonitor.abort();
    await engine.stop();
  }
}

export async function launchAuthorityDaemon(input: {
  projectRoot: string;
  version: string;
  /** Exact installed-generation binding; production discovers it from Core's launcher path. */
  activeInstallation?: ActiveInstallationBinding;
  /**
   * Packaged-release evidence only. The daemon still crosses the exact authenticated bootstrap,
   * but its attempt sessions stop after durable admission so the smoke cannot call a provider.
   */
  providerFreeAdmissionProbe?: true;
}): Promise<AuthorityDaemonLaunch> {
  const activeInstallation =
    input.activeInstallation ??
    (await bindVersionedActiveInstallation(
      fileURLToPath(new URL("../../bin/koni.js", import.meta.url)),
    ));
  if (activeInstallation !== undefined) {
    await assertActiveInstallationCurrent(activeInstallation);
  }
  if (input.providerFreeAdmissionProbe === true && process.env.NODE_ENV !== "test") {
    throw new AuthorityBootstrapError(
      "provider_free_probe",
      "provider-free authority admission is available only to the packaged test boundary",
    );
  }
  const endpoint = await discoverAuthorityEndpoint(input.projectRoot);
  const piPeerRuntime = await resolvePiPeerRuntime();
  const runtimeClosure = await captureRuntimeClosure(import.meta.url, piPeerRuntime.packageRoot);
  await assertRuntimeClosureCurrent(runtimeClosure);
  const runtimeClosurePin = await persistRuntimeClosurePin(endpoint.stateRoot, runtimeClosure);
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
        env: authorityDaemonEnvironment(
          {
            ...piPeerRuntime.environment,
            ...(activeInstallation === undefined
              ? {}
              : activeInstallationEnvironment(activeInstallation)),
            [KONI_RUNTIME_CLOSURE_ENV]: runtimeClosurePin.closureSha256,
            [KONI_RUNTIME_PIN_PATH_ENV]: runtimeClosurePin.path,
            [KONI_RUNTIME_PIN_SHA256_ENV]: runtimeClosurePin.pinSha256,
          },
          input.providerFreeAdmissionProbe === true,
        ),
      },
    );
  } finally {
    await log.close();
  }
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  child.unref();
  return { ...(child.pid === undefined ? {} : { pid: child.pid }), exited };
}

/** @internal Exported only for a mutation-catching process-boundary regression. */
export function authorityDaemonEnvironment(
  piEnvironment: Readonly<Record<string, string>>,
  providerFreeAdmissionProbe = false,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...piEnvironment,
    KONI_AUTHORITY_DAEMON: "1",
    ...(providerFreeAdmissionProbe
      ? {
          KONI_PROVIDER_FREE_RELEASE_PROBE: "1",
          NODE_ENV: "test",
          PI_OFFLINE: "1",
        }
      : {}),
  };
  // The exact peer bridge is an argv preload above. Never forward ambient Node injection into the
  // authority process, even when the interactive launcher itself was started through NODE_OPTIONS.
  for (const name of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "NPM_CONFIG_NODE_OPTIONS",
    "NODE_INSPECT_RESUME_ON_START",
  ]) {
    delete environment[name];
  }
  return environment;
}

/**
 * A release-fixture-only admission seal. It deliberately reads Pi's built-in model descriptor
 * without treating a missing user credential as provider permission. The matching run is created
 * with activation withheld and must be paused/deleted before a provider request is possible.
 */
async function loadProviderFreeTestModelBinding(provider: string, modelId: string) {
  if (process.env.NODE_ENV !== "test" || process.env.KONI_PROVIDER_FREE_RELEASE_PROBE !== "1") {
    throw new AuthorityBootstrapError(
      "provider_free_probe",
      "provider-free model admission is available only to the packaged test boundary",
    );
  }
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const matches = runtime
    .getModels()
    .filter((candidate) => candidate.provider === provider && candidate.id === modelId);
  if (matches.length !== 1) {
    throw new AuthorityBootstrapError(
      "provider_free_model",
      `Pi's built-in catalog did not expose one descriptor for ${provider}/${modelId}`,
    );
  }
  return sealPiModelDescriptor(matches[0]!);
}

export async function createProjectRun(
  options: {
    projectRoot: string;
    version: string;
    objective: string;
    runTypeId: string;
    targetRef: string;
    intake?: Record<string, string>;
    createTarget?: boolean;
    baseRef?: string;
  },
  dependencies: {
    ensure?: typeof ensureProjectAuthority;
    loadModels?: typeof loadSealedPiModelCatalog;
  } = {},
): Promise<{ runId: string; status: string; modelNotice?: string }> {
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
    // The non-interactive path has no selector to correct a profile default that this Pi
    // installation cannot execute, so bind each role to an authenticated model and report it.
    const resolved = resolveRoleModelSelections(runType.roles, models);
    assertSealedModelAdmission(resolved.roles, models);
    const modelNotice = describeRoleModelSubstitutions(resolved.substitutions);
    const roleOverrides = Object.fromEntries(
      resolved.substitutions.map((substitution) => [
        substitution.roleId,
        {
          provider: substitution.to.provider,
          model: substitution.to.model,
          thinkingLevel: substitution.to.thinkingLevel,
        },
      ]),
    );
    const response = await client.request(
      "run.create",
      {
        objective: options.objective,
        runTypeId: options.runTypeId,
        targetRef: normalizeTargetRef(options.targetRef),
        intake: options.intake ?? { goal: options.objective },
        ...(options.createTarget === true ? { createTarget: true } : {}),
        ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
        ...(resolved.substitutions.length === 0 ? {} : { overrides: { roles: roleOverrides } }),
      },
      {
        expectedRevision: client.revision,
        idempotencyKey: `operator-run-create:${randomUUID()}`,
      },
    );
    return {
      ...parseRunCreation(response),
      ...(modelNotice === undefined ? {} : { modelNotice }),
    };
  } finally {
    client.close();
  }
}

/** Resume paused/blocked work or explicitly revalidate a merge-ready compiler board. */
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

/**
 * Approve a run parked at its approval gate.
 *
 * Without this the approval gate is reachable only from the TUI, so a headless or scripted
 * operator can start a run and then has no way to advance it.
 */
export async function approveProjectRun(options: {
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
      "plan.approve",
      { runId: options.runId },
      {
        expectedRevision: client.revision,
        idempotencyKey: `operator-plan-approve:${options.runId}:${randomUUID()}`,
      },
    );
    return parseRunCreation(response);
  } finally {
    client.close();
  }
}

/**
 * Authorize the merge of a run that has reached its promotion boundary.
 *
 * The capability is confirmation-gated and carries a run-revision binding, so the exact control has
 * to be read back from `run.controls` rather than synthesized. Without this the operator seat stops
 * one step short of a finished run and a human has to open the TUI purely to press a button.
 */
/**
 * Acknowledge a held provider-exposure reservation so the run can be retried.
 *
 * Held exposure is an acknowledge-then-retry condition, not a plain resume: the authority gates the
 * retry behind `requiresProviderExposureRetirement`, so resuming without acknowledging simply
 * re-blocks. The TUI has always offered this control; without a CLI equivalent an unattended
 * operator can only resume, which is why one run burned twelve consecutive resumes against a
 * blocker that needed one acknowledgement.
 */
export async function acknowledgeProviderExposure(options: {
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
    const controls = (await client.request("run.controls", { runId: options.runId }))
      .result as unknown as {
      binding: { runRevision: number; generation: number };
      runActions: ReadonlyArray<{
        id: string;
        intent: string;
        availability: { state: string; reason?: string };
      }>;
    };
    const action = controls.runActions.find(
      (candidate) => candidate.intent === "retire_provider_exposure",
    );
    if (action === undefined || action.availability.state !== "available") {
      throw new Error(
        `run ${options.runId} has no available provider-exposure acknowledgement: ${
          action?.availability.reason ?? "control absent"
        }`,
      );
    }
    const response = await client.request(
      "run.action.execute",
      {
        protocol: "koni.stage-action-invocation.v1",
        runId: options.runId,
        runRevision: controls.binding.runRevision,
        generation: controls.binding.generation,
        capabilityId: action.id,
        confirmed: true,
        values: {},
      },
      {
        expectedRevision: client.revision,
        idempotencyKey: `operator-acknowledge-exposure:${options.runId}:${randomUUID()}`,
      },
    );
    return parseRunCreation(response);
  } finally {
    client.close();
  }
}

export async function mergeProjectRun(options: {
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
    const controls = (await client.request("run.controls", { runId: options.runId }))
      .result as unknown as {
      binding: { runRevision: number; generation: number };
      runActions: ReadonlyArray<{
        id: string;
        intent: string;
        availability: { state: string; reason?: string };
      }>;
    };
    const action = controls.runActions.find((candidate) => candidate.intent === "authorize_merge");
    if (action === undefined) {
      throw new Error(`run ${options.runId} exposes no merge authorization control`);
    }
    if (action.availability.state !== "available") {
      throw new Error(
        `run ${options.runId} cannot authorize its merge yet: ${action.availability.reason ?? action.availability.state}`,
      );
    }
    const response = await client.request(
      "run.action.execute",
      {
        protocol: "koni.stage-action-invocation.v1",
        runId: options.runId,
        runRevision: controls.binding.runRevision,
        generation: controls.binding.generation,
        capabilityId: action.id,
        confirmed: true,
        values: {},
      },
      {
        expectedRevision: client.revision,
        idempotencyKey: `operator-merge:${options.runId}:${randomUUID()}`,
      },
    );
    return parseRunCreation(response);
  } finally {
    client.close();
  }
}

/**
 * Decide one durable change proposal from the CLI. A proposal that no operator answers holds its
 * source ticket forever: the scheduler keeps a `proposal` role ticket in `proposed` until it carries
 * exact approval authority, so the run deadlocks with every remaining ticket waiting on a decision
 * nobody was asked for. The TUI and the Pi companion could already answer one; an operator driving
 * Koni headlessly could not, which made the change-request escape hatch unreachable exactly when a
 * run depended on it.
 */
export async function decideProjectProposal(options: {
  projectRoot: string;
  version: string;
  runId: string;
  ticketId?: string;
  decision: "approval" | "rejection";
  message?: string;
}): Promise<{ runId: string; ticketId: string; decision: string }> {
  const client = await ensureProjectAuthority({
    projectRoot: options.projectRoot,
    version: options.version,
    client: "cli",
  });
  try {
    const run = (await client.request("run.get", { runId: options.runId }))
      .result as unknown as RunRecord;
    const pending = undecidedProposalTickets(run);
    const ticketId = options.ticketId;
    const target = proposalTicketForOperatorDecision(run, ticketId);
    if (target === undefined) {
      const listed = pending.map((ticket) => `${ticket.id} (${ticket.title})`).join("; ");
      throw new Error(
        pending.length === 0
          ? `run ${options.runId} has no change proposal awaiting a decision`
          : ticketId === undefined
            ? `run ${options.runId} has ${pending.length} proposals awaiting a decision; pass --proposal: ${listed}`
            : `run ${options.runId} has no undecided proposal ${ticketId}; awaiting: ${listed}`,
      );
    }
    const inspection = (
      await client.request("proposal.inspect", { runId: options.runId, ticketId: target.id })
    ).result as unknown as { requestSha256: string };
    await client.request(
      "proposal.decide",
      {
        runId: options.runId,
        ticketId: target.id,
        requestSha256: inspection.requestSha256,
        decision: options.decision,
        ...(options.message === undefined ? {} : { message: options.message }),
      },
      {
        expectedRevision: client.revision,
        idempotencyKey: `operator-proposal:${options.runId}:${target.id}:${randomUUID()}`,
      },
    );
    return { runId: options.runId, ticketId: target.id, decision: options.decision };
  } finally {
    client.close();
  }
}

function undecidedProposalTickets(run: Readonly<RunRecord>): TicketRecord[] {
  return Object.values(run.tickets).filter(
    (ticket) =>
      ticket.status === "proposed" &&
      ticket.executionControl?.proposalRequest !== undefined &&
      ticket.executionControl.proposalDecision === undefined,
  );
}

/**
 * Resolve an operator proposal target without making audit-only steering ambiguous.
 *
 * An omitted id retains the safe CLI shorthand and considers only undecided proposals. An exact
 * id may also select a proposal whose approval already owns execution authority: the authority RPC
 * records that later decision as audit history without revoking the approval. This is how an
 * operator corrects a running proposal worker while preserving the original hash-bound grant.
 */
export function proposalTicketForOperatorDecision(
  run: Readonly<RunRecord>,
  ticketId?: string,
): TicketRecord | undefined {
  const pending = undecidedProposalTickets(run);
  if (ticketId === undefined) return pending.length === 1 ? pending[0] : undefined;
  return Object.values(run.tickets).find(
    (ticket) =>
      ticket.id === ticketId &&
      ticket.executionControl?.proposalRequest !== undefined &&
      (pending.includes(ticket) || ticket.executionControl.proposalApprovalSha256 !== undefined),
  );
}

type AuthorityProbe =
  { status: "ready"; client: AuthorityClient } | { status: "starting" } | { status: "absent" };

async function probeAuthority(options: {
  projectRoot: string;
  version: string;
  client: ProtocolHandshake["client"];
  connectTimeoutMs?: number;
}): Promise<AuthorityProbe> {
  try {
    return {
      status: "ready",
      client: await AuthorityClient.connect({
        projectRoot: options.projectRoot,
        client: options.client,
        version: options.version,
        connectTimeoutMs: options.connectTimeoutMs ?? 750,
      }),
    };
  } catch (error) {
    if (error instanceof AuthorityClientError && error.code === "authority_starting") {
      return { status: "starting" };
    }
    if (authorityUnavailable(error)) return { status: "absent" };
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

function isRetryableAuthorityStop(error: unknown): boolean {
  return (
    error instanceof Error &&
    "retryable" in error &&
    (error as Error & { retryable?: unknown }).retryable === true
  );
}

function parseProjectStatus(
  response: RpcSuccess,
): NonNullable<ProjectAuthorityStatus["authority"]> {
  if (!isRecord(response.result))
    throw new AuthorityBootstrapError("authority_status", "authority returned invalid status");
  const result = response.result as unknown as Record<string, unknown>;
  const { version, revision, runCount } = result;
  if (
    typeof version !== "string" ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    typeof runCount !== "number" ||
    !Number.isSafeInteger(runCount)
  )
    throw new AuthorityBootstrapError("authority_status", "authority returned invalid status");
  return { version, revision, runCount };
}

function parseRunCreation(response: RpcSuccess): { runId: string; status: string } {
  const result = response.result as unknown;
  if (!isRecord(result) || typeof result.runId !== "string" || typeof result.status !== "string")
    throw new AuthorityBootstrapError(
      "run_create",
      "authority returned an invalid run creation response",
    );
  return { runId: result.runId, status: result.status };
}

interface ParsedQuiesceResult {
  pausedRunCount: number;
  pausedRunIds: string[];
  pausedRunIdsTruncated: boolean;
}

function parseQuiesceResult(response: RpcSuccess): ParsedQuiesceResult {
  if (
    !isRecord(response.result) ||
    (response.result.status !== "quiesced" && response.result.status !== "quiescing") ||
    !Array.isArray(response.result.pausedRunIds) ||
    !response.result.pausedRunIds.every((value) => typeof value === "string")
  ) {
    throw new AuthorityBootstrapError(
      "authority_quiesce",
      "authority returned an invalid quiesce response",
    );
  }
  const pausedRunIds = [...response.result.pausedRunIds];
  // Compatibility daemons returned only the complete ID array. New daemons return an exact count
  // plus a bounded sample so a stop response can never amplify with project history.
  if (
    response.result.pausedRunCount === undefined &&
    response.result.pausedRunIdsTruncated === undefined
  ) {
    return { pausedRunCount: pausedRunIds.length, pausedRunIds, pausedRunIdsTruncated: false };
  }
  if (
    !Number.isSafeInteger(response.result.pausedRunCount) ||
    Number(response.result.pausedRunCount) < 0 ||
    typeof response.result.pausedRunIdsTruncated !== "boolean" ||
    Number(response.result.pausedRunCount) < pausedRunIds.length ||
    response.result.pausedRunIdsTruncated !==
      Number(response.result.pausedRunCount) > pausedRunIds.length
  ) {
    throw new AuthorityBootstrapError(
      "authority_quiesce",
      "authority returned invalid bounded quiesce totals",
    );
  }
  return {
    pausedRunCount: Number(response.result.pausedRunCount),
    pausedRunIds,
    pausedRunIdsTruncated: response.result.pausedRunIdsTruncated,
  };
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
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
