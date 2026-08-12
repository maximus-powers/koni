import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
  loadProjectContextFiles,
  type PackageSource,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import { canonicalHash, compareUtf8, rawSha256, type Sha256Digest } from "../shared/canonical.js";
import {
  DiagnosticBag,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from "../shared/diagnostics.js";
import type { CompiledConfiguration, ConfigurationObject } from "../contracts/configuration.js";

export type PiAgentResourceKind = "skill" | "extension" | "prompt" | "theme" | "context";
export type PiAgentResourceScope = "user" | "project";

export interface PiResolvedResource {
  readonly kind: PiAgentResourceKind;
  readonly id: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly content: string;
  readonly source: string;
  readonly scope: PiAgentResourceScope;
}

export interface PiResolvedInventory {
  readonly settings: Readonly<{
    packages?: PackageSource[];
    extensions?: string[];
    skills?: string[];
    prompts?: string[];
    themes?: string[];
  }>;
  readonly resources: Readonly<{
    skills: readonly PiResolvedResource[];
    extensions: readonly PiResolvedResource[];
    prompts: readonly PiResolvedResource[];
    themes: readonly PiResolvedResource[];
    context: readonly PiResolvedResource[];
  }>;
}

export interface PiAgentSettingsFilter {
  readonly packages?: readonly PackageSource[];
  readonly extensions?: readonly string[];
  readonly skills?: readonly string[];
  readonly prompts?: readonly string[];
  readonly themes?: readonly string[];
}

export interface PiAgentToolFilter {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

export interface PiAgentDefinition {
  readonly id: string;
  readonly extends?: string;
  readonly description?: string;
  readonly instructions: string;
  readonly pi?: Readonly<{
    provider?: string;
    model?: string;
    thinking_level?: ThinkingLevel;
    settings?: PiAgentSettingsFilter;
    tools?: PiAgentToolFilter;
  }>;
  readonly koni: Readonly<{
    role: string;
    capabilities?: Readonly<Record<string, unknown>>;
  }>;
}

export type PiAgentCatalog = Readonly<Record<string, PiAgentDefinition>>;
export type KoniExtensionAdapterRegistry = Readonly<Record<string, string>>;

export interface ResolvedPiAgentResource extends PiResolvedResource {
  readonly sha256: Sha256Digest;
  readonly sizeBytes: number;
}

export interface ResolvedPiAgentExtension {
  readonly id: string;
  readonly source: string;
  readonly relativePath: string;
  readonly status: "compatible" | "excluded";
  readonly adapter?: string;
  readonly reason?: string;
}

export interface ResolvedPiAgentConfiguration {
  readonly agentId: string;
  readonly ancestry: readonly string[];
  readonly description: string;
  readonly instructions: string;
  readonly model?: Readonly<{
    provider: string;
    id: string;
    thinkingLevel: ThinkingLevel;
  }>;
  readonly settings: PiAgentSettingsFilter;
  readonly resources: Readonly<{
    skills: readonly ResolvedPiAgentResource[];
    extensions: readonly ResolvedPiAgentResource[];
    prompts: readonly ResolvedPiAgentResource[];
    themes: readonly ResolvedPiAgentResource[];
    context: readonly ResolvedPiAgentResource[];
  }>;
  readonly extensions: readonly ResolvedPiAgentExtension[];
  readonly tools: readonly Readonly<{ name: string }>[];
  readonly koni: Readonly<{
    role: string;
    capabilities: Readonly<Record<string, unknown>>;
  }>;
  readonly configurationSha256: Sha256Digest;
}

export interface ResolvePiAgentConfigurationOptions {
  readonly agentId: string;
  readonly agents: PiAgentCatalog;
  readonly inventory: PiResolvedInventory;
  readonly extensionAdapters: KoniExtensionAdapterRegistry;
}

const SAFE_PI_TOOLS = ["edit", "find", "grep", "ls", "read", "write"] as const;
const SAFE_PI_TOOL_SET = new Set<string>(SAFE_PI_TOOLS);
const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

export interface LoadPiResolvedInventoryOptions {
  readonly projectRoot: string;
  readonly agentDir?: string;
  /** Use Pi's normal missing-package installation path. Read-only callers leave this false. */
  readonly installMissingPackages?: boolean;
  /** Test/read-only discovery may explicitly omit missing packages instead of installing them. */
  readonly skipMissingPackages?: boolean;
}

/** Project the schema-3 compiler output into the Pi overlay resolver's typed catalog. */
export function piAgentCatalogFromCompiledConfiguration(
  configuration: CompiledConfiguration,
): PiAgentCatalog {
  return deepFreeze(
    Object.fromEntries(
      Object.entries(configuration.agents)
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([id, resource]) => {
          const document = resource.document;
          const pi = configurationRecord(document.pi);
          const koni = configurationRecord(document.koni);
          const definition: PiAgentDefinition = {
            id,
            ...(typeof document.extends === "string" ? { extends: document.extends } : {}),
            ...(typeof document.description === "string"
              ? { description: document.description }
              : {}),
            instructions: String(document.instructions ?? ""),
            ...(pi === undefined
              ? {}
              : {
                  pi: {
                    ...(typeof pi.provider === "string" ? { provider: pi.provider } : {}),
                    ...(typeof pi.model === "string" ? { model: pi.model } : {}),
                    ...(typeof pi.thinking_level === "string"
                      ? { thinking_level: pi.thinking_level as ThinkingLevel }
                      : {}),
                    ...(configurationRecord(pi.settings) === undefined
                      ? {}
                      : {
                          settings: structuredClone(
                            configurationRecord(pi.settings),
                          ) as unknown as PiAgentSettingsFilter,
                        }),
                    ...(configurationRecord(pi.tools) === undefined
                      ? {}
                      : {
                          tools: structuredClone(
                            configurationRecord(pi.tools),
                          ) as unknown as PiAgentToolFilter,
                        }),
                  },
                }),
            koni: {
              role: typeof koni?.role === "string" ? koni.role : "",
              capabilities: structuredClone(configurationRecord(koni?.capabilities) ?? {}),
            },
          };
          return [id, definition] as const;
        }),
    ),
  );
}

/** Resolve the same global, project, package, and context inventory that ordinary Pi sees. */
export async function loadPiResolvedInventory(
  options: LoadPiResolvedInventoryOptions,
): Promise<PiResolvedInventory> {
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(options.projectRoot, agentDir, {
    projectTrusted: true,
  });
  const packageManager = new DefaultPackageManager({
    cwd: options.projectRoot,
    agentDir,
    settingsManager,
  });
  const resolved = await packageManager.resolve(
    options.installMissingPackages === true
      ? undefined
      : async () => (options.skipMissingPackages === true ? "skip" : "error"),
  );
  const configuredPackages = packageManager.listConfiguredPackages();
  const resources = {
    skills: await materializePiResources("skill", resolved.skills, options.projectRoot, agentDir),
    extensions: await materializePiResources(
      "extension",
      resolved.extensions,
      options.projectRoot,
      agentDir,
    ),
    prompts: await materializePiResources(
      "prompt",
      resolved.prompts,
      options.projectRoot,
      agentDir,
    ),
    themes: await materializePiResources("theme", resolved.themes, options.projectRoot, agentDir),
    context: loadProjectContextFiles({ cwd: options.projectRoot, agentDir })
      .map(({ path: contextPath, content }) => ({
        kind: "context" as const,
        id: path.basename(contextPath),
        relativePath: relativeResourcePath(contextPath, options.projectRoot, agentDir),
        absolutePath: contextPath,
        content,
        source: contextPath.startsWith(options.projectRoot + path.sep) ? "project" : "user",
        scope: contextPath.startsWith(options.projectRoot + path.sep)
          ? ("project" as const)
          : ("user" as const),
      }))
      .sort(resourceOrder),
  };
  return deepFreeze({
    settings: {
      packages: configuredPackages.map(({ source }) => source),
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    },
    resources,
  });
}

/**
 * Compile a Koni agent as a narrowing overlay over Pi's already-resolved repository environment.
 * This function never installs packages and never imports extension code.
 */
export function resolvePiAgentConfiguration(
  options: ResolvePiAgentConfigurationOptions,
): ValidationResult<ResolvedPiAgentConfiguration> {
  const bag = new DiagnosticBag();
  const leaf = options.agents[options.agentId];
  if (leaf === undefined) {
    bag.error(
      "agent.unknown",
      `/agents/${escapePointer(options.agentId)}`,
      "agent is not configured",
    );
    return validationFailure(bag.sorted());
  }
  validateIdentity(leaf, options.agentId, bag);

  let definition = leaf;
  let ancestry = [options.agentId];
  if (leaf.extends !== undefined) {
    const parent = options.agents[leaf.extends];
    if (parent === undefined) {
      bag.error(
        "agent.unknown_parent",
        `/agents/${escapePointer(options.agentId)}/extends`,
        `parent agent ${leaf.extends} is not configured`,
      );
    } else if (parent.extends !== undefined) {
      bag.error(
        "agent.extends_depth",
        `/agents/${escapePointer(options.agentId)}/extends`,
        "agent inheritance supports exactly one optional parent",
      );
    } else {
      validateIdentity(parent, leaf.extends, bag);
      definition = mergeAgent(parent, leaf);
      ancestry = [leaf.extends, options.agentId];
    }
  }

  validatePackageNarrowing(definition.pi?.settings, options.inventory, options.agentId, bag);
  const resources = filterResources(
    definition.pi?.settings,
    options.inventory,
    options.agentId,
    bag,
  );
  const tools = resolveTools(definition.pi?.tools, options.agentId, bag);
  const extensions = resources.extensions
    .map((resource) => {
      const adapter = options.extensionAdapters[`${resource.source}::${resource.relativePath}`];
      return adapter === undefined
        ? {
            id: resource.id,
            source: resource.source,
            relativePath: resource.relativePath,
            status: "excluded" as const,
            reason: "interactive_only / excluded: no Koni adapter",
          }
        : {
            id: resource.id,
            source: resource.source,
            relativePath: resource.relativePath,
            status: "compatible" as const,
            adapter,
          };
    })
    .sort(
      (left, right) =>
        Number(left.status === "excluded") - Number(right.status === "excluded") ||
        compareUtf8(left.id, right.id),
    );

  const provider = definition.pi?.provider;
  const model = definition.pi?.model;
  const thinkingLevel = definition.pi?.thinking_level;
  if (
    [provider, model, thinkingLevel].some((value) => value !== undefined) &&
    [provider, model, thinkingLevel].some((value) => value === undefined)
  ) {
    bag.error(
      "agent.model_selection",
      `/agents/${escapePointer(options.agentId)}/pi`,
      "provider, model, and thinking_level must be selected together",
    );
  }
  if (definition.instructions.trim().length === 0) {
    bag.error(
      "agent.instructions",
      `/agents/${escapePointer(options.agentId)}/instructions`,
      "agent instructions must be nonempty",
    );
  }
  if (bag.hasErrors()) return validationFailure(bag.sorted());

  const material = {
    agentId: options.agentId,
    ancestry,
    description: definition.description ?? "",
    instructions: definition.instructions,
    ...(provider === undefined || model === undefined || thinkingLevel === undefined
      ? {}
      : { model: { provider, id: model, thinkingLevel } }),
    settings: clone(definition.pi?.settings ?? {}),
    resources,
    extensions,
    tools,
    koni: {
      role: definition.koni.role,
      capabilities: clone(definition.koni.capabilities ?? {}),
    },
  };
  return validationSuccess(
    deepFreeze({ ...material, configurationSha256: canonicalHash(material) }),
    bag.sorted(),
  );
}

function mergeAgent(parent: PiAgentDefinition, leaf: PiAgentDefinition): PiAgentDefinition {
  const settings = leaf.pi?.settings ?? parent.pi?.settings;
  const tools = leaf.pi?.tools ?? parent.pi?.tools;
  return {
    ...parent,
    ...leaf,
    instructions: leaf.instructions,
    pi: {
      ...parent.pi,
      ...leaf.pi,
      ...(settings === undefined ? {} : { settings }),
      ...(tools === undefined ? {} : { tools }),
    },
    koni: {
      ...parent.koni,
      ...leaf.koni,
      capabilities: {
        ...(parent.koni.capabilities ?? {}),
        ...(leaf.koni.capabilities ?? {}),
      },
    },
  };
}

function validateIdentity(definition: PiAgentDefinition, key: string, bag: DiagnosticBag): void {
  if (definition.id !== key) {
    bag.error(
      "agent.registry_id",
      `/agents/${escapePointer(key)}/id`,
      `agent id ${definition.id} does not match registry key ${key}`,
    );
  }
}

function validatePackageNarrowing(
  filter: PiAgentSettingsFilter | undefined,
  inventory: PiResolvedInventory,
  agentId: string,
  bag: DiagnosticBag,
): void {
  if (filter?.packages === undefined) return;
  const available = new Set((inventory.settings.packages ?? []).map(packageSource));
  for (const [index, entry] of filter.packages.entries()) {
    const source = packageSource(entry);
    if (!available.has(source)) {
      bag.error(
        "agent.package_not_in_inventory",
        `/agents/${escapePointer(agentId)}/pi/settings/packages/${index}`,
        `agent cannot add Pi package ${source}; install it through Pi first`,
      );
    }
  }
}

function filterResources(
  filter: PiAgentSettingsFilter | undefined,
  inventory: PiResolvedInventory,
  agentId: string,
  bag: DiagnosticBag,
): ResolvedPiAgentConfiguration["resources"] {
  const packageFilters = new Map<string, Exclude<PackageSource, string>>();
  const selectedPackages =
    filter?.packages === undefined
      ? undefined
      : new Set(
          filter.packages.map((entry) => {
            if (typeof entry !== "string") packageFilters.set(entry.source, entry);
            return packageSource(entry);
          }),
        );

  const output = {} as Record<(typeof RESOURCE_FIELDS)[number], readonly ResolvedPiAgentResource[]>;
  for (const field of RESOURCE_FIELDS) {
    const resources = inventory.resources[field];
    const directPatterns = filter?.[field];
    validatePatterns(directPatterns, resources, agentId, `pi/settings/${field}`, bag);
    const selected = resources.filter((resource) => {
      const isPackage = resource.source !== "project";
      if (isPackage && selectedPackages !== undefined && !selectedPackages.has(resource.source)) {
        return false;
      }
      const packageEntry = packageFilters.get(resource.source);
      const packagePatterns = packageEntry?.[field];
      if (packagePatterns !== undefined) {
        validatePatterns(
          packagePatterns,
          resources.filter((candidate) => candidate.source === resource.source),
          agentId,
          `pi/settings/packages/${escapePointer(resource.source)}/${field}`,
          bag,
        );
        if (!matchesFilters(resource.relativePath, packagePatterns)) return false;
      }
      return directPatterns === undefined || matchesFilters(resource.relativePath, directPatterns);
    });
    output[field] = preferPiResourceOverrides(selected).map(sealResource).sort(resourceOrder);
  }
  return deepFreeze({
    ...output,
    context: inventory.resources.context.map(sealResource).sort(resourceOrder),
  });
}

function preferPiResourceOverrides(resources: readonly PiResolvedResource[]): PiResolvedResource[] {
  const selected = new Map<string, PiResolvedResource>();
  for (const resource of resources) {
    const existing = selected.get(resource.id);
    if (existing === undefined || piResourcePrecedence(resource) < piResourcePrecedence(existing)) {
      selected.set(resource.id, resource);
    }
  }
  return [...selected.values()];
}

function piResourcePrecedence(resource: PiResolvedResource): number {
  if (resource.source === "project") return 0;
  if (resource.source === "user") return 1;
  return 2;
}

function validatePatterns(
  patterns: readonly string[] | undefined,
  resources: readonly PiResolvedResource[],
  agentId: string,
  path: string,
  bag: DiagnosticBag,
): void {
  if (patterns === undefined) return;
  for (const [index, raw] of patterns.entries()) {
    const pattern =
      raw.startsWith("!") || raw.startsWith("+") || raw.startsWith("-") ? raw.slice(1) : raw;
    if (raw.startsWith("!") || raw.startsWith("-")) continue;
    if (!resources.some((resource) => globMatch(resource.relativePath, pattern))) {
      bag.error(
        "agent.resource_not_in_inventory",
        `/agents/${escapePointer(agentId)}/${path}/${index}`,
        `agent resource filter ${raw} does not match Pi's resolved inventory`,
      );
    }
  }
}

function matchesFilters(path: string, patterns: readonly string[]): boolean {
  const positives = patterns.filter(
    (pattern) => !pattern.startsWith("!") && !pattern.startsWith("-"),
  );
  let included =
    positives.length === 0
      ? false
      : positives.some((pattern) =>
          globMatch(path, pattern.startsWith("+") ? pattern.slice(1) : pattern),
        );
  for (const pattern of patterns) {
    if ((pattern.startsWith("!") || pattern.startsWith("-")) && globMatch(path, pattern.slice(1))) {
      included = false;
    }
    if (pattern.startsWith("+") && globMatch(path, pattern.slice(1))) included = true;
  }
  return included;
}

function globMatch(path: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  const expression = escaped
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${expression}$`, "u").test(path);
}

function resolveTools(
  filter: PiAgentToolFilter | undefined,
  agentId: string,
  bag: DiagnosticBag,
): readonly Readonly<{ name: string }>[] {
  const included = new Set(filter?.include ?? SAFE_PI_TOOLS);
  for (const name of included) {
    if (!SAFE_PI_TOOL_SET.has(name)) {
      bag.error(
        "agent.unsafe_tool",
        `/agents/${escapePointer(agentId)}/pi/tools/include`,
        `tool ${name} is not a Koni-contained Pi tool`,
      );
    }
  }
  for (const name of filter?.exclude ?? []) included.delete(name);
  return [...included]
    .filter((name) => SAFE_PI_TOOL_SET.has(name))
    .sort(compareUtf8)
    .map((name) => Object.freeze({ name }));
}

function sealResource(resource: PiResolvedResource): ResolvedPiAgentResource {
  return deepFreeze({
    ...resource,
    sha256: rawSha256(resource.content),
    sizeBytes: Buffer.byteLength(resource.content),
  });
}

function resourceOrder(left: PiResolvedResource, right: PiResolvedResource): number {
  return compareUtf8(left.id, right.id) || compareUtf8(left.relativePath, right.relativePath);
}

function packageSource(source: PackageSource): string {
  return typeof source === "string" ? source : source.source;
}

async function materializePiResources(
  kind: Exclude<PiAgentResourceKind, "context">,
  resources: readonly ResolvedResource[],
  projectRoot: string,
  agentDir: string,
): Promise<PiResolvedResource[]> {
  const materialized = await Promise.all(
    resources
      .filter((resource) => resource.enabled)
      .map(async (resource): Promise<PiResolvedResource> => {
        const resourcePath = path.resolve(resource.path);
        const stats = await lstat(resourcePath);
        const contentPath = stats.isDirectory()
          ? path.join(resourcePath, "SKILL.md")
          : resourcePath;
        const content = await readFile(contentPath, "utf8");
        const relativePath =
          resource.metadata.baseDir === undefined
            ? relativeResourcePath(contentPath, projectRoot, agentDir)
            : path.relative(resource.metadata.baseDir, contentPath).split(path.sep).join("/");
        const source =
          resource.metadata.origin === "top-level"
            ? resource.metadata.scope === "project"
              ? "project"
              : "user"
            : resource.metadata.source;
        return {
          kind,
          id: resourceId(kind, resourcePath, content),
          relativePath,
          absolutePath: contentPath,
          content,
          source,
          scope: resource.metadata.scope === "user" ? "user" : "project",
        };
      }),
  );
  return materialized.sort(resourceOrder);
}

function resourceId(
  kind: Exclude<PiAgentResourceKind, "context">,
  resourcePath: string,
  content: string,
): string {
  if (kind === "skill") {
    const frontmatterName = content.match(/^---\r?\n[\s\S]*?^name:\s*([^\r\n]+)$/mu)?.[1]?.trim();
    if (frontmatterName !== undefined && frontmatterName.length > 0) return frontmatterName;
  }
  const name = path.basename(resourcePath);
  return path.extname(name).length === 0 ? name : name.slice(0, -path.extname(name).length);
}

function relativeResourcePath(resourcePath: string, projectRoot: string, agentDir: string): string {
  const root = resourcePath.startsWith(projectRoot + path.sep) ? projectRoot : agentDir;
  return path.relative(root, resourcePath).split(path.sep).join("/");
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function configurationRecord(value: unknown): ConfigurationObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ConfigurationObject)
    : undefined;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
