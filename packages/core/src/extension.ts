import type {
  EventBus,
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
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
} from "./operator/control-center-host.js";
import {
  installAndCacheProfile,
  PiProfileSourceCatalog,
  readInstalledProfileReference,
  resolveProfilePackageRoot,
  type KoniProfileSourceDescriptor,
} from "./operator/profile-source.js";

export interface KoniExtensionDependencies {
  assertPiHost(): Promise<void>;
  openControlCenter(context: ExtensionCommandContext): Promise<void>;
  createRun(context: ExtensionCommandContext, runType?: string): Promise<unknown>;
  inspect(projectRoot: string): ReturnType<typeof inspectProjectAuthority>;
  validate(projectRoot: string): ReturnType<typeof validateProjectConfiguration>;
  ensure(projectRoot: string): Promise<{ close(): void }>;
  stop(projectRoot: string): ReturnType<typeof stopProjectAuthority>;
  install(input: { projectRoot: string; packageRoot: string }): ReturnType<typeof installAndCacheProfile>;
  readInstalled(projectRoot: string): ReturnType<typeof readInstalledProfileReference>;
  resolveProfile(
    selector: string,
    sources: readonly KoniProfileSourceDescriptor[],
  ): Promise<string>;
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
 * Registration is deliberately inert: no daemon, profile read, auth access, resource mutation,
 * or UI is created until the operator explicitly invokes `/koni`.
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
    const dependencies: KoniExtensionDependencies = {
      assertPiHost: async () => { await resolvePiPeerRuntime(); },
      openControlCenter: (context) => openPiControlCenter({ context, version: KONI_CORE_API_VERSION }),
      createRun: (context, runType) => createRunFromPi({
        context,
        version: KONI_CORE_API_VERSION,
        ...(runType === undefined ? {} : { requestedRunType: runType }),
      }),
      inspect: (projectRoot) => inspectProjectAuthority({
        projectRoot,
        version: KONI_CORE_API_VERSION,
      }),
      validate: validateProjectConfiguration,
      ensure: async (projectRoot) => ensureProjectAuthority({
        projectRoot,
        version: KONI_CORE_API_VERSION,
        client: "pi-extension",
      }),
      stop: (projectRoot) => stopProjectAuthority({
        projectRoot,
        version: KONI_CORE_API_VERSION,
      }),
      install: ({ projectRoot, packageRoot }) => installAndCacheProfile({
        projectRoot,
        profilePackageRoot: packageRoot,
      }),
      readInstalled: readInstalledProfileReference,
      resolveProfile: resolveProfilePackageRoot,
      ...dependencyOverrides,
    };

    pi.registerCommand("koni", {
      description: "Open Koni or run an explicit project operation",
      getArgumentCompletions: (prefix) => commandCompletions(prefix),
      handler: async (argumentsText, context) => {
        try {
          instance.assertSingle();
          await handleKoniCommand({
            argumentsText,
            context,
            profiles,
            dependencies,
          });
        } catch (error) {
          context.ui.notify(operatorError(error), "error");
        }
      },
    });
    pi.on("session_start", async (_event, context) => {
      const duplicates = pi.getCommands().filter((command) =>
        command.source === "extension" && /^(?:koni|koni:[1-9][0-9]*)$/u.test(command.name));
      if (duplicates.length > 1) {
        context.ui.notify(duplicateCoreOriginMessage(duplicates), "error");
        // Pi has already renamed the commands, so a legacy instance could otherwise remain callable.
        // Shutting down is the only fail-closed action that covers guard-unaware historical builds.
        context.shutdown();
        return;
      }
      try {
        await dependencies.assertPiHost();
      } catch (error) {
        context.ui.notify(`Koni cannot run in this Pi host: ${operatorError(error)}`, "error");
        context.shutdown();
      }
    });
    pi.on("session_shutdown", () => {
      profiles.dispose();
      instance.dispose();
    });
  };
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
    typeof candidate.instanceId !== "string" || candidate.instanceId.length === 0 ||
    typeof candidate.version !== "string" || candidate.version.length === 0 ||
    typeof candidate.origin !== "string" || candidate.origin.length === 0
  ) return undefined;
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
    .sort((left, right) =>
      left.scope.localeCompare(right.scope) || left.source.localeCompare(right.source))
    .map((source) => {
      if (source.scope === "temporary") {
        return `- temporary ${source.source}: restart Pi without this temporary extension source`;
      }
      const local = source.scope === "project" ? " --local" : "";
      return `- ${source.scope} ${source.source}: \`pi remove ${shellQuote(source.source)}${local}\``;
    });
  return [
    "Multiple @koni/core origins are loaded, so Pi renamed /koni and Koni stopped this session before any work could start.",
    "Run `pi list`, keep exactly one current Koni source, and remove the others using the matching scope:",
    ...guidance,
    "Then start Pi again (or `/reload` from a clean still-running session). Unrelated Pi packages and project resources must remain installed.",
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
      await input.dependencies.openControlCenter(input.context);
      return;
    case "new":
    case "run":
      await input.dependencies.createRun(input.context, arguments_[0]);
      await input.dependencies.openControlCenter(input.context);
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
          ? `Koni authority stopped. ${stopped.pausedRunIds.length} active run(s) were paused.`
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
        `Koni authority restarted. ${stopped.pausedRunIds.length} run(s) remain paused until explicitly resumed.`,
        "info",
      );
      return;
    }
    case "status": {
      const status = await input.dependencies.inspect(input.context.cwd);
      const authority = status.running && status.authority !== undefined
        ? `running · revision ${status.authority.revision} · ${status.authority.runCount} runs`
        : "stopped";
      const profile = status.profile === undefined
        ? "no profile installed"
        : `${status.profile.packageName}@${status.profile.profileVersion}`;
      input.context.ui.notify(`Koni ${authority}\nProfile: ${profile}`, "info");
      return;
    }
    case "config": {
      const status = await input.dependencies.validate(input.context.cwd);
      if (!status.ok || status.configuration === undefined) {
        throw new Error(status.diagnostics.map((diagnostic) =>
          `${diagnostic.path}: ${diagnostic.message}`).join("\n"));
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
      const selector = arguments_[0] ?? await selectInitialProfile(input.context, sources);
      if (selector === undefined) return;
      const packageRoot = await input.dependencies.resolveProfile(selector, sources);
      const result = await input.dependencies.install({ projectRoot: input.context.cwd, packageRoot });
      input.context.ui.notify(
        `Installed ${result.packageName}@${result.profileVersion} (${result.added.length} files).`,
        "info",
      );
      return;
    }
    case "update": {
      const installed = await input.dependencies.readInstalled(input.context.cwd);
      const sources = input.profiles.discover();
      const selector = arguments_[0] ?? installed.packageName;
      const packageRoot = await input.dependencies.resolveProfile(selector, sources);
      const result = await input.dependencies.install({ projectRoot: input.context.cwd, packageRoot });
      const preserved = result.preserved.length === 0
        ? "No project overrides needed preservation."
        : `Preserved ${result.preserved.length} project override(s).`;
      input.context.ui.notify(
        `Updated ${result.packageName}@${result.profileVersion}. ${preserved}`,
        "info",
      );
      return;
    }
    case "help":
      input.context.ui.notify(
        "/koni · dashboard\n/koni new [run-type]\n/koni status\n/koni config\n/koni init [coding|research]\n/koni update [profile]\n/koni start\n/koni stop\n/koni restart",
        "info",
      );
      return;
    default:
      throw new Error(`unknown /koni action: ${command}; use /koni help`);
  }
}

async function selectInitialProfile(
  context: ExtensionCommandContext,
  sources: readonly KoniProfileSourceDescriptor[],
): Promise<string | undefined> {
  if (sources.length === 0) return "coding";
  if (sources.length === 1) return sources[0]!.package;
  return context.ui.select("Project profile", sources.map((source) => source.package));
}

function commandCompletions(prefix: string): Array<{ value: string; label: string; description?: string }> {
  const choices = [
    ["new", "Create a guided run"],
    ["status", "Show authority and profile status"],
    ["config", "Validate and summarize project configuration"],
    ["init", "Install a profile into this repository"],
    ["update", "Upgrade the installed profile without overwriting overrides"],
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

function splitArguments(value: string): string[] {
  const output: string[] = [];
  let token = "";
  let quote: "'" | "\"" | undefined;
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
    } else if (character === "'" || character === "\"") {
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
