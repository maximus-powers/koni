import { chmod, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
  type InlineExtension,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AgentLaunchSpec, LaunchResource } from "./launch-spec.js";

const INLINE_EXTENSION_NAME = "koni-managed-session";

export interface ContainedResourceLoaderResult {
  loader: ResourceLoader;
  settingsManager: SettingsManager;
  resourceRoot: string;
}

export class ContainedResourceError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ContainedResourceError";
    this.code = code;
  }
}

/**
 * Materialize the immutable compiler-issued resource bundle and construct a Pi loader that cannot
 * discover or accept ambient resources. Pi's credential/model runtime is deliberately separate.
 */
export async function createContainedResourceLoader(options: {
  spec: Readonly<AgentLaunchSpec>;
  extension: InlineExtension;
}): Promise<ContainedResourceLoaderResult> {
  const { spec } = options;
  await mkdir(spec.workspace.sessionDirectory, { recursive: true, mode: 0o700 });
  const sessionDirectory = await realpath(spec.workspace.sessionDirectory);
  const resourceRoot = path.join(sessionDirectory, `resources-${spec.specHash.slice("sha256:".length, 22)}`);
  try {
    await mkdir(resourceRoot, { mode: 0o700 });
  } catch (error) {
    if (isCode(error, "EEXIST")) {
      throw new ContainedResourceError(
        "resource_replay",
        `resource directory already exists for attempt ${spec.identity.attemptId}`,
      );
    }
    throw error;
  }

  const materialized = new Map<string, string>();
  try {
    for (const resource of spec.resources.entries) {
      const destination = await materializeResource(resourceRoot, resource);
      materialized.set(resource.id, destination);
    }
  } catch (error) {
    throw error instanceof ContainedResourceError
      ? error
      : new ContainedResourceError("materialization", error instanceof Error ? error.message : String(error));
  }

  const skillPaths = pathsForKind(spec.resources.entries, materialized, "skill");
  const promptPaths = pathsForKind(spec.resources.entries, materialized, "prompt");
  const contexts = spec.resources.entries
    .filter((resource) => resource.kind === "context")
    .map((resource) => ({ path: materialized.get(resource.id)!, content: resource.content }));
  const appendSystemPrompt = spec.resources.entries
    .filter((resource) => resource.kind === "append_system_prompt")
    .map((resource) => resource.content);
  const settingsManager = SettingsManager.inMemory({
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
    enableSkillCommands: false,
  }, { projectTrusted: false });
  const isolatedAgentDir = path.join(resourceRoot, ".pi-agent");
  await mkdir(isolatedAgentDir, { mode: 0o700 });
  const namedExtension: InlineExtension = typeof options.extension === "function"
    ? { name: INLINE_EXTENSION_NAME, factory: options.extension }
    : options.extension.name === INLINE_EXTENSION_NAME
      ? options.extension
      : { name: INLINE_EXTENSION_NAME, factory: options.extension.factory };
  const delegate = new DefaultResourceLoader({
    cwd: spec.workspace.cwd,
    agentDir: isolatedAgentDir,
    settingsManager,
    extensionFactories: [namedExtension],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalSkillPaths: skillPaths,
    additionalPromptTemplatePaths: promptPaths,
    systemPrompt: spec.persona.systemPrompt,
    appendSystemPrompt,
    agentsFilesOverride: () => ({ agentsFiles: contexts }),
    themesOverride: () => ({ themes: [], diagnostics: [] }),
  });
  await delegate.reload();
  assertContained(delegate, spec, skillPaths.length, promptPaths.length, contexts.length);

  return {
    loader: new SealedResourceLoader(delegate),
    settingsManager,
    resourceRoot,
  };
}

class SealedResourceLoader implements ResourceLoader {
  readonly #delegate: DefaultResourceLoader;

  public constructor(delegate: DefaultResourceLoader) {
    this.#delegate = delegate;
  }

  public getExtensions(): ReturnType<ResourceLoader["getExtensions"]> {
    return this.#delegate.getExtensions();
  }

  public getSkills(): ReturnType<ResourceLoader["getSkills"]> {
    return this.#delegate.getSkills();
  }

  public getPrompts(): ReturnType<ResourceLoader["getPrompts"]> {
    return this.#delegate.getPrompts();
  }

  public getThemes(): ReturnType<ResourceLoader["getThemes"]> {
    return this.#delegate.getThemes();
  }

  public getAgentsFiles(): ReturnType<ResourceLoader["getAgentsFiles"]> {
    return this.#delegate.getAgentsFiles();
  }

  public getSystemPrompt(): string | undefined {
    return this.#delegate.getSystemPrompt();
  }

  public getAppendSystemPrompt(): string[] {
    return this.#delegate.getAppendSystemPrompt();
  }

  public extendResources(_paths: Parameters<ResourceLoader["extendResources"]>[0]): void {
    throw new ContainedResourceError(
      "resource_extension_denied",
      "contained autonomous sessions cannot extend their compiler-issued resource set",
    );
  }

  public reload(_options?: Parameters<ResourceLoader["reload"]>[0]): Promise<void> {
    return Promise.reject(new ContainedResourceError(
      "resource_reload_denied",
      "contained autonomous sessions cannot rediscover resources",
    ));
  }
}

async function materializeResource(root: string, resource: LaunchResource): Promise<string> {
  const destination = path.join(root, resource.relativePath);
  if (!isWithin(root, destination)) {
    throw new ContainedResourceError("resource_escape", `resource ${resource.id} escapes its attempt root`);
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const handle = await open(destination, "wx", 0o400);
  try {
    await handle.writeFile(resource.content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(destination, 0o400);
  return destination;
}

function assertContained(
  loader: DefaultResourceLoader,
  spec: Readonly<AgentLaunchSpec>,
  skills: number,
  prompts: number,
  contexts: number,
): void {
  const extensions = loader.getExtensions();
  if (
    extensions.errors.length !== 0 ||
    extensions.extensions.length !== 1 ||
    extensions.extensions[0]?.path !== `<inline:${INLINE_EXTENSION_NAME}>`
  ) {
    throw new ContainedResourceError("extension_inventory", "contained loader did not resolve exactly the Koni inline extension");
  }
  if (
    loader.getSkills().skills.length !== skills ||
    loader.getSkills().diagnostics.some((entry) => entry.type === "error") ||
    loader.getPrompts().prompts.length !== prompts ||
    loader.getPrompts().diagnostics.some((entry) => entry.type === "error") ||
    loader.getAgentsFiles().agentsFiles.length !== contexts ||
    loader.getThemes().themes.length !== 0 ||
    loader.getSystemPrompt() !== spec.persona.systemPrompt
  ) {
    throw new ContainedResourceError("resource_inventory", "Pi resolved resources outside the compiler-issued inventory");
  }
}

function pathsForKind(
  resources: readonly LaunchResource[],
  materialized: ReadonlyMap<string, string>,
  kind: LaunchResource["kind"],
): string[] {
  return resources
    .filter((resource) => resource.kind === kind)
    .map((resource) => materialized.get(resource.id)!);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
