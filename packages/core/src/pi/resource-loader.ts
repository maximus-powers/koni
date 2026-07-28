import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
  type InlineExtension,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AgentLaunchSpec, LaunchResource } from "./launch-spec.js";
import { createFileAtomicallyNoReplace } from "./atomic-file.js";

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
  mode?: "fresh" | "recover";
}): Promise<ContainedResourceLoaderResult> {
  const { spec } = options;
  const mode = options.mode ?? "fresh";
  await mkdir(spec.workspace.sessionDirectory, { recursive: true, mode: 0o700 });
  const sessionDirectory = await realpath(spec.workspace.sessionDirectory);
  const resourceRoot = path.join(
    sessionDirectory,
    `resources-${spec.specHash.slice("sha256:".length)}`,
  );
  if (mode === "fresh") {
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
  } else {
    let resourceRootStat = await lstat(resourceRoot).catch(() => undefined);
    if (resourceRootStat === undefined) {
      try {
        await mkdir(resourceRoot, { mode: 0o700 });
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
      }
      resourceRootStat = await lstat(resourceRoot).catch(() => undefined);
    }
    if (
      resourceRootStat === undefined ||
      !resourceRootStat.isDirectory() ||
      resourceRootStat.isSymbolicLink() ||
      (resourceRootStat.mode & 0o077) !== 0
    ) {
      throw new ContainedResourceError(
        "resource_recovery",
        "recovered resource root is missing or unsafe",
      );
    }
  }

  const materialized = new Map<string, string>();
  try {
    for (const resource of spec.resources.entries) {
      const destination =
        mode === "fresh"
          ? await materializeResource(resourceRoot, resource)
          : await recoverMaterializedResource(resourceRoot, resource);
      materialized.set(resource.id, destination);
    }
  } catch (error) {
    throw error instanceof ContainedResourceError
      ? error
      : new ContainedResourceError(
          "materialization",
          error instanceof Error ? error.message : String(error),
        );
  }

  // A pinned skill closure can contain references, scripts, and assets. Only SKILL.md is a Pi
  // discovery entry point; closure members remain available through `koni_read_resource`.
  const skillPaths = pathsForKind(spec.resources.entries, materialized, "skill").filter(
    (entry) => path.basename(entry) === "SKILL.md",
  );
  const promptPaths = pathsForKind(spec.resources.entries, materialized, "prompt");
  // Pi only advertises skills when a literal built-in `read` tool is active. Contained Koni
  // sessions intentionally never grant that ambient filesystem capability, so compiler-selected
  // skill bodies must enter the model through the sealed system context instead of becoming dead
  // loader metadata. Static `context` resources are materialized/hash-checked for audit, but are
  // not injected here: the managed extension is their single authoritative, refreshable channel.
  const embeddedSkills = spec.resources.entries
    .filter(
      (resource) =>
        resource.kind === "skill" && path.posix.basename(resource.relativePath) === "SKILL.md",
    )
    .map((resource) => ({ path: materialized.get(resource.id)!, content: resource.content }));
  const appendSystemPrompt = spec.resources.entries
    .filter((resource) => resource.kind === "append_system_prompt")
    .map((resource) => resource.content);
  const settingsManager = SettingsManager.inMemory(
    {
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
      enableSkillCommands: false,
    },
    { projectTrusted: false },
  );
  const isolatedAgentDir = path.join(resourceRoot, ".pi-agent");
  await mkdir(isolatedAgentDir, { recursive: mode === "recover", mode: 0o700 });
  const namedExtension: InlineExtension =
    typeof options.extension === "function"
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
    agentsFilesOverride: () => ({ agentsFiles: embeddedSkills }),
    themesOverride: () => ({ themes: [], diagnostics: [] }),
  });
  await delegate.reload();
  assertContained(delegate, spec, skillPaths.length, promptPaths.length, embeddedSkills.length);

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
    return Promise.reject(
      new ContainedResourceError(
        "resource_reload_denied",
        "contained autonomous sessions cannot rediscover resources",
      ),
    );
  }
}

async function materializeResource(root: string, resource: LaunchResource): Promise<string> {
  const destination = path.join(root, resource.relativePath);
  if (!isWithin(root, destination)) {
    throw new ContainedResourceError(
      "resource_escape",
      `resource ${resource.id} escapes its attempt root`,
    );
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (!(await createFileAtomicallyNoReplace(destination, resource.content, 0o400))) {
    throw new ContainedResourceError("resource_replay", `resource ${resource.id} already exists`);
  }
  return destination;
}

async function recoverMaterializedResource(
  root: string,
  resource: LaunchResource,
): Promise<string> {
  const destination = path.join(root, resource.relativePath);
  if (!isWithin(root, destination)) {
    throw new ContainedResourceError(
      "resource_escape",
      `resource ${resource.id} escapes its attempt root`,
    );
  }
  const existing = await lstat(destination).catch(() => undefined);
  if (existing !== undefined) return verifyMaterializedResource(root, resource);

  await ensurePrivateRecoveryParents(root, path.dirname(destination), resource.id);
  await createFileAtomicallyNoReplace(destination, resource.content, 0o400);
  return verifyMaterializedResource(root, resource);
}

async function ensurePrivateRecoveryParents(
  root: string,
  parent: string,
  resourceId: string,
): Promise<void> {
  const relative = path.relative(root, parent);
  if (relative === "") return;
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let metadata = await lstat(current).catch(() => undefined);
    if (metadata === undefined) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
      }
      metadata = await lstat(current).catch(() => undefined);
    }
    if (
      metadata === undefined ||
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new ContainedResourceError(
        "resource_recovery",
        `resource ${resourceId} traverses an unsafe path`,
      );
    }
  }
}

async function verifyMaterializedResource(root: string, resource: LaunchResource): Promise<string> {
  const destination = path.join(root, resource.relativePath);
  if (!isWithin(root, destination)) {
    throw new ContainedResourceError(
      "resource_escape",
      `resource ${resource.id} escapes its attempt root`,
    );
  }
  await assertPrivateRealPath(root, destination, resource.id);
  let handle;
  try {
    handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new ContainedResourceError(
      "resource_recovery",
      `resource ${resource.id} is missing or unsafe`,
    );
  }
  let metadata: Stats;
  let bytes: Buffer;
  try {
    metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o222) !== 0) {
      throw new ContainedResourceError(
        "resource_recovery",
        `resource ${resource.id} is missing or unsafe`,
      );
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const after = await lstat(destination).catch(() => undefined);
  if (
    after === undefined ||
    after.isSymbolicLink() ||
    after.dev !== metadata.dev ||
    after.ino !== metadata.ino
  ) {
    throw new ContainedResourceError(
      "resource_recovery",
      `resource ${resource.id} changed during verification`,
    );
  }
  if (bytes.byteLength !== resource.sizeBytes || bytes.toString("utf8") !== resource.content) {
    throw new ContainedResourceError(
      "resource_drift",
      `resource ${resource.id} changed after its launch was issued`,
    );
  }
  return destination;
}

async function assertPrivateRealPath(
  root: string,
  destination: string,
  resourceId: string,
): Promise<void> {
  const resolvedRoot = await realpath(root).catch(() => undefined);
  const resolvedDestination = await realpath(destination).catch(() => undefined);
  if (
    resolvedRoot === undefined ||
    resolvedDestination === undefined ||
    resolvedRoot !== root ||
    resolvedDestination !== destination ||
    !isWithin(resolvedRoot, resolvedDestination)
  ) {
    throw new ContainedResourceError(
      "resource_recovery",
      `resource ${resourceId} traverses an unsafe path`,
    );
  }
  const relative = path.relative(root, destination);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const metadata = await lstat(current).catch(() => undefined);
    const isLeaf = current === destination;
    if (
      metadata === undefined ||
      metadata.isSymbolicLink() ||
      (!isLeaf && (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0))
    ) {
      throw new ContainedResourceError(
        "resource_recovery",
        `resource ${resourceId} traverses an unsafe path`,
      );
    }
  }
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
    throw new ContainedResourceError(
      "extension_inventory",
      "contained loader did not resolve exactly the Koni inline extension",
    );
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
    throw new ContainedResourceError(
      "resource_inventory",
      "Pi resolved resources outside the compiler-issued inventory",
    );
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
