import type {
  EventBus,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { assertExecutingCoreRuntimeCurrent } from "./runtime/identity.js";
import { resolvePiPeerRuntime } from "./runtime/pi-peer-runtime.js";
import { KONI_CORE_API_VERSION } from "./contracts/profile-package.js";
import {
  ensureProjectAuthority,
  inspectProjectAuthority,
  stopProjectAuthority,
  validateProjectConfiguration,
} from "./operator/authority-bootstrap.js";
import {
  createRunFromPi,
  openPiControlCenter,
  projectPiModels,
} from "./operator/control-center-host.js";
import {
  installAndCacheProfile,
  previewProfileUpdate,
  PiProfileSourceCatalog,
  readInstalledProfileReference,
  resolveProfilePackageRoot,
  type KoniProfileSourceDescriptor,
} from "./operator/profile-source.js";
import {
  connectRunningKoniAuthority,
  createKoniInteractiveProposalTools,
  createKoniInteractiveReadTools,
  type KoniReadAuthorityClient,
} from "./pi/interactive-tools.js";
import { MonitorController, type MonitorAuthorityConnection } from "./monitor/index.js";
import {
  PiMonitorBinding,
  notifyPiMonitor,
  openPiGuidedRunModal,
  openPiRunsOverlay,
  piMonitorHostFromUi,
  type PiMonitorHostAdapter,
} from "./monitor/pi-host.js";
import { prepareGuidedRunIntake } from "./monitor/run-intake.js";
import type { ControlModelOption } from "./control-center/protocol.js";

export interface KoniExtensionDependencies {
  assertCoreRuntime(): Promise<void>;
  assertPiHost(): Promise<void>;
  openControlCenter(context: ExtensionCommandContext): Promise<void>;
  createRun(context: ExtensionCommandContext, runType?: string): Promise<unknown>;
  inspect(projectRoot: string): ReturnType<typeof inspectProjectAuthority>;
  validate(projectRoot: string): ReturnType<typeof validateProjectConfiguration>;
  ensure(projectRoot: string): Promise<{
    close(): void;
    readonly revision?: number;
    request?: Awaited<ReturnType<typeof ensureProjectAuthority>>["request"];
  }>;
  stop(projectRoot: string): ReturnType<typeof stopProjectAuthority>;
  install(input: {
    projectRoot: string;
    packageRoot: string;
    expectedPreviewSha256?: import("./shared/canonical.js").Sha256Digest;
  }): ReturnType<typeof installAndCacheProfile>;
  previewInstall(input: {
    projectRoot: string;
    packageRoot: string;
  }): ReturnType<typeof previewProfileUpdate>;
  readInstalled(projectRoot: string): ReturnType<typeof readInstalledProfileReference>;
  resolveProfile(
    selector: string,
    sources: readonly KoniProfileSourceDescriptor[],
  ): Promise<string>;
  connectReadOnly(projectRoot: string): Promise<KoniReadAuthorityClient | undefined>;
  /** Passive attach only. This dependency must never start or recover an authority. */
  connectMonitor(projectRoot: string): Promise<MonitorAuthorityConnection | undefined>;
  /** Explicit `/koni-run` connector; the operator command may start the project authority. */
  connectRunIntake(projectRoot: string): Promise<MonitorAuthorityConnection>;
  loadModels(context: Pick<ExtensionContext, "modelRegistry">): Promise<ControlModelOption[]>;
}

const KONI_CORE_DISCOVER_EVENT = "koni.core.discover.v1";
const KONI_CORE_AVAILABLE_EVENT = "koni.core.available.v1";
const KONI_CORE_INSTANCE_PROTOCOL = "koni.core-instance.v1";

interface KoniCoreInstanceDescriptor {
  protocol: typeof KONI_CORE_INSTANCE_PROTOCOL;
  instanceId: string;
  version: string;
  origin: string;
}

/**
 * Construct Koni's installed Pi extension.
 *
 * Registration never starts an authority or performs a provider request. In an already trusted,
 * initialized project, `session_start` ensures the project authority is running (autostart;
 * disable with `KONI_AUTOSTART=0`) and attaches the bounded read-only companion. Beyond that
 * boundary, commands remain the only route to starting work or mutating durable Koni state — in
 * particular `/koni stop` is never undone by a passive reattach.
 */
export function createKoniCoreExtension(
  dependencyOverrides: Partial<KoniExtensionDependencies> = {},
): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    const instance = new KoniCoreInstanceGuard(pi.events, {
      protocol: KONI_CORE_INSTANCE_PROTOCOL,
      instanceId: randomUUID(),
      version: KONI_CORE_API_VERSION,
      origin: import.meta.url,
    });
    const profiles = new PiProfileSourceCatalog(pi.events);
    let monitorRuntime: PiMonitorRuntime | undefined;
    const dependencies: KoniExtensionDependencies = {
      assertCoreRuntime: assertExecutingCoreRuntimeCurrent,
      assertPiHost: async () => {
        await resolvePiPeerRuntime();
      },
      openControlCenter: (context) =>
        openPiControlCenter({ context, version: KONI_CORE_API_VERSION }),
      createRun: (context, runType) =>
        createRunFromPi({
          context,
          version: KONI_CORE_API_VERSION,
          ...(runType === undefined ? {} : { requestedRunType: runType }),
        }),
      inspect: (projectRoot) =>
        inspectProjectAuthority({
          projectRoot,
          version: KONI_CORE_API_VERSION,
        }),
      validate: validateProjectConfiguration,
      ensure: async (projectRoot) =>
        ensureProjectAuthority({
          projectRoot,
          version: KONI_CORE_API_VERSION,
          client: "pi-extension",
        }),
      stop: (projectRoot) =>
        stopProjectAuthority({
          projectRoot,
          version: KONI_CORE_API_VERSION,
        }),
      install: ({ projectRoot, packageRoot, expectedPreviewSha256 }) =>
        installAndCacheProfile({
          projectRoot,
          profilePackageRoot: packageRoot,
          ...(expectedPreviewSha256 === undefined ? {} : { expectedPreviewSha256 }),
        }),
      previewInstall: ({ projectRoot, packageRoot }) =>
        previewProfileUpdate({
          projectRoot,
          profilePackageRoot: packageRoot,
        }),
      readInstalled: readInstalledProfileReference,
      resolveProfile: resolveProfilePackageRoot,
      connectReadOnly: (projectRoot) =>
        connectRunningKoniAuthority({
          projectRoot,
          version: KONI_CORE_API_VERSION,
        }),
      connectMonitor: async (projectRoot) => {
        const client = await connectRunningKoniAuthority({
          projectRoot,
          version: KONI_CORE_API_VERSION,
        });
        return client === undefined ? undefined : asMonitorConnection(client);
      },
      connectRunIntake: async (projectRoot) =>
        ensureProjectAuthority({
          projectRoot,
          version: KONI_CORE_API_VERSION,
          client: "pi-extension",
        }),
      loadModels: (context) => projectPiModels(context),
      ...dependencyOverrides,
    };

    const disposeMonitor = (): void => {
      monitorRuntime?.binding.dispose();
      monitorRuntime?.controller.dispose();
      monitorRuntime = undefined;
    };
    const mountMonitor = async (
      context: ExtensionContext,
    ): Promise<PiMonitorRuntime | undefined> => {
      disposeMonitor();
      if (context.mode !== "tui" || !projectTrusted(context)) return undefined;
      let initialized = false;
      try {
        initialized = (await dependencies.inspect(context.cwd)).profile !== undefined;
      } catch {
        // Ordinary Pi use outside a Git/Koni project must remain completely unaffected.
        return undefined;
      }
      if (!initialized) return undefined;
      const host = piMonitorHostFromUi(context.ui);
      const controller = new MonitorController({
        eligibility: { trusted: true, initialized: true },
        connect: () => dependencies.connectMonitor(context.cwd),
        onNotice: (notice) => notifyPiMonitor(host, notice),
      });
      const binding = new PiMonitorBinding({ controller, host });
      const runtime = { cwd: context.cwd, controller, binding, host };
      monitorRuntime = runtime;
      await controller.start();
      return monitorRuntime === runtime ? runtime : undefined;
    };
    const currentMonitor = async (
      context: ExtensionContext,
    ): Promise<PiMonitorRuntime | undefined> => {
      if (monitorRuntime?.cwd === context.cwd) return monitorRuntime;
      return mountMonitor(context);
    };
    // Session-start only: an explicit `/koni stop` must stay stopped, so this is deliberately not
    // part of `mountMonitor`, which also reattaches after lifecycle commands.
    const autostartAuthority = async (context: ExtensionContext): Promise<void> => {
      if (process.env.KONI_AUTOSTART === "0") return;
      if (context.mode !== "tui" || !projectTrusted(context)) return;
      let initialized = false;
      try {
        initialized = (await dependencies.inspect(context.cwd)).profile !== undefined;
      } catch {
        // Ordinary Pi use outside a Git/Koni project must remain completely unaffected.
        return;
      }
      if (!initialized) return;
      try {
        (await dependencies.ensure(context.cwd)).close();
      } catch (error) {
        // A failed autostart must never degrade the Pi session; surface it and leave the
        // passive monitor to report the stopped authority.
        context.ui.notify(operatorError(error), "warning");
      }
    };
    const openFullControlCenter = async (context: ExtensionCommandContext): Promise<void> => {
      const runtime = await currentMonitor(context);
      runtime?.controller.suspend();
      try {
        await dependencies.openControlCenter(context);
      } finally {
        await runtime?.controller.resume();
      }
    };
    const openGuidedRun = async (
      context: ExtensionCommandContext,
      requestedRunType?: string,
    ): Promise<void> => {
      if (!context.hasUI || context.mode !== "tui") {
        context.ui.notify("Run intake requires an interactive Pi TUI.", "warning");
        return;
      }
      const trusted = projectTrusted(context);
      let initialized = false;
      if (trusted) {
        try {
          initialized = (await dependencies.inspect(context.cwd)).profile !== undefined;
        } catch {
          initialized = false;
        }
      }
      if (!trusted || !initialized) {
        const blocked = await prepareGuidedRunIntake({
          trusted,
          initialized,
          connect: () => dependencies.connectRunIntake(context.cwd),
          models: [],
          ...(requestedRunType === undefined ? {} : { requestedRunType }),
        });
        if (blocked.kind !== "blocked") {
          blocked.session.close();
          throw new Error(
            "guided intake unexpectedly opened outside an initialized trusted project",
          );
        }
        context.ui.notify(blocked.message, blocked.reason === "untrusted" ? "warning" : "info");
        return;
      }
      const prepared = await prepareGuidedRunIntake({
        trusted,
        initialized,
        connect: () => dependencies.connectRunIntake(context.cwd),
        models: await dependencies.loadModels(context),
        ...(requestedRunType === undefined ? {} : { requestedRunType }),
      });
      if (prepared.kind === "blocked")
        throw new Error("guided intake became unavailable after initialization");
      try {
        const result = await openPiGuidedRunModal({
          host: piMonitorHostFromUi(context.ui),
          state: prepared.state,
          create: (state) => prepared.session.create(state),
        });
        if (result.kind === "cancel") return;
        const selected = result.state.runTypes[result.state.runTypeIndex]!;
        context.ui.notify(`Started ${selected.title} run.`, "info");
        if (result.warning !== undefined) context.ui.notify(result.warning, "warning");
        // The explicit command has already started work. Reattach read-only now so the provisional
        // run is visible immediately instead of waiting for the stopped-controller backoff.
        await mountMonitor(context);
      } finally {
        prepared.session.close();
      }
    };
    const openRuns = async (context: ExtensionContext): Promise<void> => {
      if (context.mode !== "tui" || !context.hasUI) {
        context.ui.notify("The Koni runs overlay requires an interactive Pi TUI.", "warning");
        return;
      }
      const runtime = await currentMonitor(context);
      if (runtime === undefined) {
        context.ui.notify(
          projectTrusted(context)
            ? "Koni is not initialized here. Run `/koni init coding` or `/koni init research`."
            : "Trust this project in Pi before opening Koni runs.",
          "info",
        );
        return;
      }
      const result = await openPiRunsOverlay({
        host: runtime.host,
        controller: runtime.controller,
      });
      if (result.kind === "open_full") {
        runtime.controller.suspend();
        try {
          await dependencies.openControlCenter(context as ExtensionCommandContext);
        } finally {
          await runtime.controller.resume();
        }
      }
    };

    // Pi 0.80.10's `registerTool` is synchronous. Registration only installs immutable schemas and
    // pure renderers; every project/runtime/authority check remains inside the eventual call.
    const interactiveToolDependencies = {
      version: KONI_CORE_API_VERSION,
      assertAvailable: async () => {
        instance.assertSingle();
        assertNoRenamedKoniDuplicates(pi);
        await dependencies.assertCoreRuntime();
        await dependencies.assertPiHost();
      },
      connect: dependencies.connectReadOnly,
    };
    const [
      projectStatusTool,
      runStatusTool,
      graphContextTool,
      ticketContextTool,
      agentTranscriptTool,
    ] = createKoniInteractiveReadTools(interactiveToolDependencies);
    const [proposalInspectTool, proposalDecisionTool] = createKoniInteractiveProposalTools(
      interactiveToolDependencies,
    );
    pi.registerTool(projectStatusTool);
    pi.registerTool(runStatusTool);
    pi.registerTool(graphContextTool);
    pi.registerTool(ticketContextTool);
    pi.registerTool(agentTranscriptTool);
    pi.registerTool(proposalInspectTool);
    pi.registerTool(proposalDecisionTool);

    pi.registerCommand("koni", {
      description: "Open Koni or run an explicit project operation",
      getArgumentCompletions: (prefix) => commandCompletions(prefix),
      handler: async (argumentsText, context) => {
        try {
          instance.assertSingle();
          assertNoRenamedKoniDuplicates(pi);
          await handleKoniCommand({
            argumentsText,
            context,
            profiles,
            dependencies,
            openFullControlCenter,
            openGuidedRun,
            openRuns,
          });
          const command = splitArguments(argumentsText)[0]?.toLowerCase();
          if (
            command === "init" ||
            command === "update" ||
            command === "start" ||
            command === "restart" ||
            command === "stop"
          ) {
            await mountMonitor(context);
          }
        } catch (error) {
          context.ui.notify(operatorError(error), "error");
        }
      },
    });
    pi.registerCommand("koni-run", {
      description: "Start a background Koni run through guided intake",
      handler: async (argumentsText, context) => {
        try {
          instance.assertSingle();
          assertNoRenamedKoniDuplicates(pi);
          await dependencies.assertCoreRuntime();
          await dependencies.assertPiHost();
          await openGuidedRun(context, splitArguments(argumentsText)[0]);
        } catch (error) {
          context.ui.notify(operatorError(error), "error");
        }
      },
    });
    pi.registerCommand("koni-runs", {
      description: "View background Koni runs and answer pending decisions",
      handler: async (_argumentsText, context) => {
        try {
          instance.assertSingle();
          assertNoRenamedKoniDuplicates(pi);
          await dependencies.assertCoreRuntime();
          await dependencies.assertPiHost();
          await openRuns(context);
        } catch (error) {
          context.ui.notify(operatorError(error), "error");
        }
      },
    });
    const registerShortcut = (pi as Partial<Pick<ExtensionAPI, "registerShortcut">>)
      .registerShortcut;
    registerShortcut?.call(pi, Key.ctrlShift("k"), {
      description: "Open Koni background runs",
      handler: (context) => openRuns(context),
    });
    pi.on("session_start", async (_event, context) => {
      const getCommands = (pi as Partial<Pick<ExtensionAPI, "getCommands">>).getCommands;
      const duplicates =
        getCommands === undefined
          ? []
          : getCommands
              .call(pi)
              .filter(
                (command) => command.source === "extension" && isKoniCommandName(command.name),
              );
      if (duplicates.length > 1) {
        // Loading Koni must never make an otherwise healthy community Pi session unusable. This
        // warning is deliberately non-mutating; exact enforcement happens only on a Koni command.
        context.ui.notify(duplicateCoreOriginMessage(duplicates), "warning");
        disposeMonitor();
        return;
      }
      await autostartAuthority(context);
      await mountMonitor(context);
    });
    pi.on("session_shutdown", () => {
      disposeMonitor();
      profiles.dispose();
      instance.dispose();
    });
  };
}

function assertNoRenamedKoniDuplicates(pi: ExtensionAPI): void {
  const getCommands = (pi as Partial<Pick<ExtensionAPI, "getCommands">>).getCommands;
  if (getCommands === undefined) return;
  const duplicates = getCommands
    .call(pi)
    .filter((command) => command.source === "extension" && isKoniCommandName(command.name));
  if (duplicates.length > 1) throw new Error(duplicateCoreOriginMessage(duplicates));
}

export default createKoniCoreExtension();

class KoniCoreInstanceGuard {
  readonly #events: EventBus;
  readonly #descriptor: KoniCoreInstanceDescriptor;
  readonly #conflicts = new Map<string, KoniCoreInstanceDescriptor>();
  readonly #unsubscribeDiscover: () => void;
  readonly #unsubscribeAvailable: () => void;

  public constructor(events: EventBus, descriptor: KoniCoreInstanceDescriptor) {
    this.#events = events;
    this.#descriptor = descriptor;
    this.#unsubscribeAvailable = events.on(KONI_CORE_AVAILABLE_EVENT, (value) => {
      const candidate = parseCoreInstanceDescriptor(value);
      if (candidate !== undefined && candidate.instanceId !== this.#descriptor.instanceId) {
        this.#conflicts.set(candidate.instanceId, candidate);
      }
    });
    this.#unsubscribeDiscover = events.on(KONI_CORE_DISCOVER_EVENT, () => this.#announce());
    events.emit(KONI_CORE_DISCOVER_EVENT, undefined);
    this.#announce();
  }

  public assertSingle(): void {
    if (this.#conflicts.size === 0) return;
    throw new Error(
      "multiple @koni/core extensions are loaded in this Pi session; run `pi list`, remove the older Koni source with `pi remove <older-koni-source> --local`, preserve unrelated packages, then run `/reload`",
    );
  }

  public dispose(): void {
    this.#unsubscribeAvailable();
    this.#unsubscribeDiscover();
    this.#conflicts.clear();
  }

  #announce(): void {
    this.#events.emit(KONI_CORE_AVAILABLE_EVENT, this.#descriptor);
  }
}

function parseCoreInstanceDescriptor(value: unknown): KoniCoreInstanceDescriptor | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Partial<KoniCoreInstanceDescriptor>;
  if (
    candidate.protocol !== KONI_CORE_INSTANCE_PROTOCOL ||
    typeof candidate.instanceId !== "string" ||
    candidate.instanceId.length === 0 ||
    typeof candidate.version !== "string" ||
    candidate.version.length === 0 ||
    typeof candidate.origin !== "string" ||
    candidate.origin.length === 0
  )
    return undefined;
  return candidate as KoniCoreInstanceDescriptor;
}

type PiCommandInfo = ReturnType<ExtensionAPI["getCommands"]>[number];

function duplicateCoreOriginMessage(commands: readonly PiCommandInfo[]): string {
  const sources = new Map<string, PiCommandInfo["sourceInfo"]>();
  for (const command of commands) {
    const key = `${command.sourceInfo.scope}\0${command.sourceInfo.source}`;
    sources.set(key, command.sourceInfo);
  }
  const guidance = [...sources.values()]
    .sort(
      (left, right) =>
        left.scope.localeCompare(right.scope) || left.source.localeCompare(right.source),
    )
    .map((source) => {
      if (source.scope === "temporary") {
        return `- temporary ${source.source}: restart Pi without this temporary extension source`;
      }
      const local = source.scope === "project" ? " --local" : "";
      return `- ${source.scope} ${source.source}: \`pi remove ${shellQuote(source.source)}${local}\``;
    });
  return [
    "Multiple @koni/core origins are loaded, so Pi renamed /koni. Ordinary Pi use remains available, but Koni commands are disabled until one current Koni source remains.",
    "Run `pi list`, keep exactly one current Koni source, and remove the others using the matching scope:",
    ...guidance,
    "Then run `/reload`. Unrelated Pi packages and project resources must remain installed.",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function handleKoniCommand(input: {
  argumentsText: string;
  context: ExtensionCommandContext;
  profiles: PiProfileSourceCatalog;
  dependencies: KoniExtensionDependencies;
  openFullControlCenter(context: ExtensionCommandContext): Promise<void>;
  openGuidedRun(context: ExtensionCommandContext, requestedRunType?: string): Promise<void>;
  openRuns(context: ExtensionContext): Promise<void>;
}): Promise<void> {
  const arguments_ = splitArguments(input.argumentsText);
  const command = arguments_.shift()?.toLowerCase() ?? "dashboard";
  // An active Pi process may still contain old JS after its package directory is replaced. Only
  // the compatibility stop path is safe across that boundary; every other operation requires a
  // reload so old code cannot mutate state while claiming the new installed build.
  if (command !== "stop") {
    await assertExecutingCoreRuntimeCurrent();
    await input.dependencies.assertPiHost();
  }
  switch (command) {
    case "dashboard":
    case "open":
      await input.openFullControlCenter(input.context);
      return;
    case "new":
    case "run":
      await input.openGuidedRun(input.context, arguments_[0]);
      return;
    case "runs":
    case "monitor":
      await input.openRuns(input.context);
      return;
    case "start": {
      const client = await input.dependencies.ensure(input.context.cwd);
      client.close();
      input.context.ui.notify("Koni authority is running for this repository.", "info");
      return;
    }
    case "stop": {
      const stopped = await input.dependencies.stop(input.context.cwd);
      input.context.ui.notify(
        stopped.wasRunning
          ? `Koni authority stopped. ${stopped.pausedRunCount} active run(s) were paused.`
          : "Koni authority was already stopped.",
        "info",
      );
      return;
    }
    case "restart": {
      const stopped = await input.dependencies.stop(input.context.cwd);
      const client = await input.dependencies.ensure(input.context.cwd);
      client.close();
      input.context.ui.notify(
        `Koni authority restarted. ${stopped.pausedRunCount} run(s) remain paused until explicitly resumed.`,
        "info",
      );
      return;
    }
    case "status": {
      const status = await input.dependencies.inspect(input.context.cwd);
      const authority =
        status.running && status.authority !== undefined
          ? `running · revision ${status.authority.revision} · ${status.authority.runCount} runs`
          : "stopped";
      const profile =
        status.profile === undefined
          ? "no profile installed"
          : `${status.profile.packageName}@${status.profile.profileVersion}`;
      input.context.ui.notify(`Koni ${authority}\nProfile: ${profile}`, "info");
      return;
    }
    case "config": {
      const status = await input.dependencies.validate(input.context.cwd);
      if (!status.ok || status.configuration === undefined) {
        throw new Error(
          status.diagnostics
            .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
            .join("\n"),
        );
      }
      input.context.ui.notify(
        [
          `${status.profile.packageName}@${status.profile.profileVersion}`,
          `Run types: ${status.configuration.runTypes.join(", ")}`,
          `Agents: ${status.configuration.agents.join(", ")}`,
          `Config: ${status.configuration.sha256}`,
        ].join("\n"),
        "info",
      );
      return;
    }
    case "init": {
      const sources = input.profiles.discover();
      const selector = arguments_[0] ?? (await selectInitialProfile(input.context, sources));
      if (selector === undefined) return;
      const packageRoot = await input.dependencies.resolveProfile(selector, sources);
      const result = await input.dependencies.install({
        projectRoot: input.context.cwd,
        packageRoot,
      });
      input.context.ui.notify(
        `Installed ${result.packageName}@${result.profileVersion} (${result.added.length} files).`,
        "info",
      );
      return;
    }
    case "conflicts": {
      const partial = await input.dependencies.ensure(input.context.cwd);
      const client = requireConflictAuthorityClient(partial);
      try {
        const catalog = parseConflictCatalog(
          (await client.request("profile.conflicts.list")).result,
        );
        if (catalog.conflicts.length === 0) {
          input.context.ui.notify("No upstream profile changes need review.", "info");
          return;
        }
        const requested = arguments_.join(" ");
        const labels = catalog.conflicts.map(
          (conflict) => `${conflict.title} · ${conflict.reason} · ${conflict.path}`,
        );
        const selectedLabel =
          requested.length === 0
            ? await input.context.ui.select("Upstream profile changes", labels)
            : labels.find((_label, index) => catalog.conflicts[index]?.path === requested);
        if (selectedLabel === undefined) return;
        const selected = catalog.conflicts[labels.indexOf(selectedLabel)]!;
        const inspected = parseConflictInspection(
          (
            await client.request("profile.conflicts.inspect", {
              path: selected.path,
            })
          ).result,
        );
        input.context.ui.notify(
          `Project:\n${inspected.currentText ?? "(deleted)"}\n\nUpstream:\n${inspected.upstreamText ?? "(deleted upstream)"}`,
          "info",
        );
        const choice = await input.context.ui.select(`${selected.title} · ${selected.reason}`, [
          "Keep project version",
          "Use upstream update",
          "Cancel",
        ]);
        if (choice === undefined || choice === "Cancel") {
          return;
        }
        const resolution = choice === "Keep project version" ? "keep_project" : "accept_upstream";
        await client.request(
          "profile.conflicts.resolve",
          {
            path: selected.path,
            expectedLifecycleGeneration: inspected.lifecycleGeneration,
            expectedProjectSha256: inspected.conflict.currentSha256,
            resolution,
          },
          {
            expectedRevision: client.revision,
            idempotencyKey: `profile.conflicts.resolve:${randomUUID()}`,
          },
        );
        input.context.ui.notify(
          `${resolution === "keep_project" ? "Kept the project version of" : "Accepted the upstream update for"} ${selected.title}.`,
          "info",
        );
      } finally {
        client.close();
      }
      return;
    }
    case "update": {
      const installed = await input.dependencies.readInstalled(input.context.cwd);
      const sources = input.profiles.discover();
      const selector = arguments_[0] ?? installed.packageName;
      const packageRoot = await input.dependencies.resolveProfile(selector, sources);
      const preview = await input.dependencies.previewInstall({
        projectRoot: input.context.cwd,
        packageRoot,
      });
      if (preview.mandatoryRetirements.length > 0) {
        input.context.ui.notify(
          [
            `This update retires ${preview.mandatoryRetirements.length} obsolete configuration contract(s).`,
            ...preview.mandatoryRetirements.flatMap((retirement) =>
              retirement.operations.map(
                (operation) =>
                  `${operation.file}${operation.pointer}: ${operation.project.present ? JSON.stringify(operation.project.value) : "already absent"}`,
              ),
            ),
            "Exact pre-update project files will be archived with a compiler-verified receipt.",
          ].join("\n"),
          "warning",
        );
        const confirmation = await input.context.ui.select(
          "Apply this exact semantic-retirement preview?",
          ["Apply update", "Cancel"],
        );
        if (confirmation !== "Apply update") return;
      }
      const result = await input.dependencies.install({
        projectRoot: input.context.cwd,
        packageRoot,
        ...(preview.mandatoryRetirements.length === 0
          ? {}
          : { expectedPreviewSha256: preview.previewSha256 }),
      });
      const preserved =
        result.preserved.length === 0
          ? "No project overrides needed preservation."
          : `Preserved ${result.preserved.length} project override(s).`;
      input.context.ui.notify(
        `Updated ${result.packageName}@${result.profileVersion}. ${preserved}${result.pendingUpstream.length === 0 ? "" : ` ${result.pendingUpstream.length} upstream change(s) need review with /koni conflicts or Configure.`}`,
        "info",
      );
      return;
    }
    case "help":
      input.context.ui.notify(
        [
          "/koni · full dashboard",
          "/koni new [run-type] · guided background run",
          "/koni runs | /koni monitor · compact run overlay",
          "/koni-run · guided background run",
          "/koni-runs · compact run overlay",
          "/koni status",
          "/koni config",
          "/koni init [coding|research]",
          "/koni update [profile]",
          "/koni conflicts [path]",
          "/koni start",
          "/koni stop",
          "/koni restart",
        ].join("\n"),
        "info",
      );
      return;
    default:
      throw new Error(`unknown /koni action: ${command}; use /koni help`);
  }
}

function requireConflictAuthorityClient(client: {
  close(): void;
  readonly revision?: number;
  request?: Awaited<ReturnType<typeof ensureProjectAuthority>>["request"];
}): {
  close(): void;
  readonly revision: number;
  request: NonNullable<typeof client.request>;
} {
  if (client.request === undefined || typeof client.revision !== "number") {
    client.close();
    throw new Error("Koni authority client does not support upstream profile review");
  }
  return {
    close: () => client.close(),
    revision: client.revision,
    request: client.request.bind(client),
  };
}

async function selectInitialProfile(
  context: ExtensionCommandContext,
  sources: readonly KoniProfileSourceDescriptor[],
): Promise<string | undefined> {
  if (sources.length === 0) return "coding";
  if (sources.length === 1) return sources[0]!.package;
  return context.ui.select(
    "Project profile",
    sources.map((source) => source.package),
  );
}

function commandCompletions(
  prefix: string,
): Array<{ value: string; label: string; description?: string }> {
  const choices = [
    ["new", "Create a guided run"],
    ["runs", "View background runs and pending decisions"],
    ["status", "Show authority and profile status"],
    ["config", "Validate and summarize project configuration"],
    ["init", "Install a profile into this repository"],
    ["update", "Upgrade the installed profile without overwriting overrides"],
    ["conflicts", "Review staged upstream profile changes"],
    ["start", "Start the repository authority"],
    ["stop", "Pause active runs and stop the repository authority"],
    ["restart", "Restart the authority on the current Core build"],
    ["help", "Show Koni commands"],
  ] as const;
  const token = prefix.trimStart();
  if (token.includes(" ")) return [];
  return choices
    .filter(([value]) => value.startsWith(token))
    .map(([value, description]) => ({ value, label: value, description }));
}

function parseConflictCatalog(value: unknown): {
  conflicts: Array<{ path: string; title: string; reason: string }>;
} {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.profile-upstream-conflict-catalog.v1" ||
    !Array.isArray(value.conflicts)
  )
    throw new Error("authority returned an invalid upstream conflict catalog");
  const conflicts = value.conflicts.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.title !== "string" ||
      typeof entry.reason !== "string"
    )
      throw new Error("authority returned an invalid upstream conflict row");
    return { path: entry.path, title: entry.title, reason: entry.reason };
  });
  return { conflicts };
}

function parseConflictInspection(value: unknown): {
  lifecycleGeneration: number;
  conflict: { currentSha256: string | null };
  currentText: string | null;
  upstreamText: string | null;
} {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.profile-upstream-conflict-inspection.v1" ||
    typeof value.lifecycleGeneration !== "number" ||
    !isRecord(value.conflict) ||
    (value.conflict.currentSha256 !== null && typeof value.conflict.currentSha256 !== "string") ||
    (value.currentText !== null && typeof value.currentText !== "string") ||
    (value.upstreamText !== null && typeof value.upstreamText !== "string")
  ) {
    throw new Error("authority returned an invalid upstream conflict inspection");
  }
  return {
    lifecycleGeneration: value.lifecycleGeneration,
    conflict: { currentSha256: value.conflict.currentSha256 },
    currentText: value.currentText,
    upstreamText: value.upstreamText,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitArguments(value: string): string[] {
  const output: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (token.length > 0) {
        output.push(token);
        token = "";
      }
    } else token += character;
  }
  if (escaped || quote !== undefined) throw new Error("unterminated /koni command argument");
  if (token.length > 0) output.push(token);
  return output;
}

function operatorError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PiMonitorRuntime {
  readonly cwd: string;
  readonly controller: MonitorController;
  readonly binding: PiMonitorBinding;
  readonly host: PiMonitorHostAdapter;
}

function projectTrusted(context: ExtensionContext): boolean {
  try {
    return typeof context.isProjectTrusted === "function" && context.isProjectTrusted() === true;
  } catch {
    return false;
  }
}

function asMonitorConnection(client: KoniReadAuthorityClient): MonitorAuthorityConnection {
  const candidate = client as KoniReadAuthorityClient & {
    onEvent?: MonitorAuthorityConnection["onEvent"];
  };
  if (typeof candidate.onEvent !== "function") {
    client.close();
    throw new Error("Koni authority connection does not support bounded monitor events");
  }
  return {
    get revision() {
      return candidate.revision;
    },
    request: (method, params, options) => candidate.request(method, params, options),
    onEvent: (listener) => candidate.onEvent!(listener),
    close: () => candidate.close(),
  };
}

function isKoniCommandName(name: string): boolean {
  // Every healthy Koni origin intentionally registers three distinct commands. Pi only renames
  // colliding copies of the same command (`koni:1`, `koni:2`, ...), so the root command is the
  // stable origin sentinel; counting `koni-run` and `koni-runs` would make one install conflict
  // with itself.
  return /^koni(?::[1-9][0-9]*)?$/u.test(name);
}
