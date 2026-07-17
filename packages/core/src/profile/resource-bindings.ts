import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
  type ResolvedPaths,
} from "@earendil-works/pi-coding-agent";
import YAML from "yaml";
import {
  PI_RESOURCE_BINDINGS_PROTOCOL,
  type OptionalPiResourceBinding,
  type PiResourceBindingCatalog,
  type PiResourceIntegration,
  type PiResourceKind,
  type PiResourceSelection,
} from "../contracts/pi-resources.js";
import { compareUtf8 } from "../shared/canonical.js";

export {
  PI_RESOURCE_BINDINGS_PROTOCOL,
  type OptionalPiResourceBinding,
  type PiResourceBindingCatalog,
  type PiResourceIntegration,
  type PiResourceKind,
  type PiResourceSelection,
} from "../contracts/pi-resources.js";

export interface InstalledPiPackageResource {
  kind: PiResourceKind;
  /** Canonical package-relative path resolved by Pi's package manager. */
  relativePath: string;
  /** Ambient enablement is informational; the project binding remains separate. */
  ambientEnabled: boolean;
}

export interface InstalledPiPackageReference {
  source: string;
  packageName: string;
  packageVersion: string;
  packageRoot: string;
  resources: readonly InstalledPiPackageResource[];
}

export interface ResolvedOptionalPiResources {
  enabled: Array<OptionalPiResourceBinding & { installedSource: string }>;
  unavailable: Array<OptionalPiResourceBinding & { unavailableReason: string }>;
  interactive: Array<OptionalPiResourceBinding & { installedSource: string }>;
  disabled: OptionalPiResourceBinding[];
}

export class PiResourceBindingError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "PiResourceBindingError";
    this.code = code;
  }
}

/** Parse the project-owned catalog. This function never installs or enables a Pi package. */
export function parsePiResourceBindingCatalog(source: string): PiResourceBindingCatalog {
  let value: unknown;
  try { value = YAML.parse(source); }
  catch (error) { throw new PiResourceBindingError("bindings_yaml", `resource binding catalog is invalid YAML: ${String(error)}`); }
  return parsePiResourceBindingValue(value);
}

/** Parse an already strict-YAML-decoded value from the authenticated configuration compiler. */
export function parsePiResourceBindingValue(value: unknown): PiResourceBindingCatalog {
  if (!isRecord(value) || value.protocol !== PI_RESOURCE_BINDINGS_PROTOCOL || !Array.isArray(value.bindings)) {
    throw new PiResourceBindingError("bindings_shape", "resource binding catalog has an invalid envelope");
  }
  rejectUnknown(value, ["protocol", "bindings"], "catalog");
  const seen = new Set<string>();
  const bindings = value.bindings.map((candidate, index) => {
    if (!isRecord(candidate)) throw new PiResourceBindingError("binding_shape", `binding ${index} is not an object`);
    rejectUnknown(candidate, ["id", "package", "description", "enabled", "integration", "resources", "select", "stages", "personas", "requires_network", "rationale"], `binding ${index}`);
    const id = requiredIdentifier(candidate.id, `binding ${index} id`);
    if (seen.has(id)) throw new PiResourceBindingError("binding_duplicate", `duplicate resource binding ${id}`);
    seen.add(id);
    const packageName = requiredPackage(candidate.package, `${id} package`);
    const integration = candidate.integration;
    if (!["skills_only", "interactive_only", "explicit_tools", "not_recommended"].includes(String(integration))) {
      throw new PiResourceBindingError("binding_integration", `${id} has an unsupported integration mode`);
    }
    if (typeof candidate.enabled !== "boolean") throw new PiResourceBindingError("binding_enabled", `${id} enabled must be boolean`);
    const resources = stringArray(candidate.resources, `${id} resources`) as PiResourceKind[];
    if (resources.some((kind) => !["extension", "skill", "prompt"].includes(kind))) {
      throw new PiResourceBindingError("binding_resource", `${id} has an unsupported resource kind`);
    }
    if (candidate.enabled && integration === "not_recommended") {
      throw new PiResourceBindingError("binding_unsafe_enable", `${id} cannot be enabled while marked not_recommended`);
    }
    if (typeof candidate.requires_network !== "boolean") {
      throw new PiResourceBindingError("binding_network", `${id} requires_network must be boolean`);
    }
    const selection = parseSelection(candidate.select, id);
    validateIntegrationSelection({
      id,
      enabled: candidate.enabled,
      integration: integration as PiResourceIntegration,
      resources,
      selection,
      stages: stringArray(candidate.stages, `${id} stages`),
      personas: stringArray(candidate.personas, `${id} personas`),
    });
    return {
      id,
      package: packageName,
      description: requiredText(candidate.description, `${id} description`),
      enabled: candidate.enabled,
      integration: integration as PiResourceIntegration,
      resources: [...new Set(resources)].sort(compareUtf8),
      select: selection,
      stages: uniqueIdentifiers(candidate.stages, `${id} stages`, `${id} stage`),
      personas: uniqueIdentifiers(candidate.personas, `${id} personas`, `${id} persona`),
      requiresNetwork: candidate.requires_network,
      rationale: requiredText(candidate.rationale, `${id} rationale`),
    };
  }).sort((left, right) => compareUtf8(left.id, right.id));
  return { protocol: PI_RESOURCE_BINDINGS_PROTOCOL, bindings };
}

export async function loadProjectPiResourceBindings(projectRoot: string): Promise<PiResourceBindingCatalog> {
  const source = await readFile(path.join(projectRoot, ".koni", "resources", "pi-packages.yaml"), "utf8");
  return parsePiResourceBindingCatalog(source);
}

/**
 * Join explicit project choices to Pi's already-installed package inventory.
 * Missing packages are reported, never installed; unrelated ambient packages
 * remain untouched and are not inherited by contained attempts.
 */
export function resolveOptionalPiResources(
  catalog: PiResourceBindingCatalog,
  installed: readonly InstalledPiPackageReference[],
): ResolvedOptionalPiResources {
  const installedByName = new Map<string, InstalledPiPackageReference>();
  for (const entry of installed) {
    if (
      !isPackageName(entry.packageName) ||
      typeof entry.source !== "string" ||
      entry.source.length === 0 ||
      typeof entry.packageVersion !== "string" ||
      entry.packageVersion.length === 0 ||
      !path.isAbsolute(entry.packageRoot) ||
      !Array.isArray(entry.resources) ||
      entry.resources.some((resource) => !isInstalledResource(resource))
    ) {
      throw new PiResourceBindingError("installed_package", "installed Pi package reference is invalid");
    }
    if (installedByName.has(entry.packageName)) {
      throw new PiResourceBindingError("installed_package_duplicate", `installed Pi package ${entry.packageName} is ambiguous`);
    }
    installedByName.set(entry.packageName, entry);
  }
  const enabled: ResolvedOptionalPiResources["enabled"] = [];
  const unavailable: ResolvedOptionalPiResources["unavailable"] = [];
  const interactive: ResolvedOptionalPiResources["interactive"] = [];
  const disabled: OptionalPiResourceBinding[] = [];
  for (const binding of catalog.bindings) {
    if (!binding.enabled) {
      disabled.push(structuredClone(binding));
      continue;
    }
    const available = installedByName.get(binding.package);
    if (available === undefined) {
      unavailable.push({
        ...structuredClone(binding),
        unavailableReason: "package is not present in Pi's resolved installed-package inventory",
      });
    } else if (binding.integration === "interactive_only") {
      interactive.push({ ...structuredClone(binding), installedSource: available.source });
    } else {
      enabled.push({ ...structuredClone(binding), installedSource: available.source });
    }
  }
  return { enabled, unavailable, interactive, disabled };
}

/**
 * Read Pi's ordinary package inventory without installing, updating, enabling, disabling, or
 * loading extension modules. Missing sources are always skipped. The returned paths are only
 * candidates; the compiler independently no-follow reads and hashes every selected byte.
 */
export async function discoverInstalledPiPackageReferences(options: {
  projectRoot: string;
  agentDir?: string;
  projectTrusted?: boolean;
}): Promise<InstalledPiPackageReference[]> {
  const projectRoot = await realpath(path.resolve(options.projectRoot));
  const agentDir = options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
  const settings = SettingsManager.create(projectRoot, agentDir, {
    projectTrusted: options.projectTrusted ?? true,
  });
  const manager = new DefaultPackageManager({
    cwd: projectRoot,
    agentDir,
    settingsManager: settings,
  });
  const resolved = await manager.resolve(async () => "skip");
  const errors = settings.drainErrors();
  if (errors.length > 0) {
    throw new PiResourceBindingError(
      "installed_settings",
      `Pi settings could not be read safely: ${errors.map(({ error }) => error.message).join("; ")}`,
    );
  }
  const byName = new Map<string, InstalledPiPackageReference>();
  for (const configured of manager.listConfiguredPackages()) {
    if (configured.installedPath === undefined) continue;
    const candidate = await inspectInstalledPackage(configured.source, configured.installedPath, resolved);
    if (candidate !== undefined) byName.set(candidate.packageName, candidate);
  }
  return [...byName.values()].sort((left, right) => compareUtf8(left.packageName, right.packageName));
}

async function inspectInstalledPackage(
  source: string,
  installedPath: string,
  resolved: ResolvedPaths,
): Promise<InstalledPiPackageReference | undefined> {
  const packageRoot = await realpath(path.resolve(installedPath)).catch(() => undefined);
  if (packageRoot === undefined) return undefined;
  const rootMetadata = await lstat(packageRoot).catch(() => undefined);
  if (rootMetadata === undefined || !rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return undefined;
  const manifestPath = path.join(packageRoot, "package.json");
  const manifest = await readJsonFileNoFollow(manifestPath, 4 * 1024 * 1024).catch(() => undefined);
  if (!isRecord(manifest) || typeof manifest.name !== "string" || !isPackageName(manifest.name)) return undefined;
  if (typeof manifest.version !== "string" || manifest.version.length === 0 || manifest.version.length > 256) return undefined;
  const resources: InstalledPiPackageResource[] = [];
  for (const [kind, entries] of [
    ["extension", resolved.extensions],
    ["skill", resolved.skills],
    ["prompt", resolved.prompts],
  ] as const) {
    for (const entry of entries) {
      if (entry.metadata.origin !== "package" || entry.metadata.baseDir === undefined) continue;
      const baseDir = await realpath(entry.metadata.baseDir).catch(() => undefined);
      if (baseDir !== packageRoot) continue;
      const resourcePath = await realpath(entry.path).catch(() => undefined);
      if (resourcePath === undefined || !isWithin(packageRoot, resourcePath)) continue;
      const relativePath = normalizeResourcePath(path.relative(packageRoot, resourcePath));
      resources.push({ kind, relativePath, ambientEnabled: entry.enabled });
    }
  }
  resources.sort((left, right) => compareUtf8(`${left.kind}\0${left.relativePath}`, `${right.kind}\0${right.relativePath}`));
  return {
    source,
    packageName: manifest.name,
    packageVersion: manifest.version,
    packageRoot,
    resources,
  };
}

async function readJsonFileNoFollow(file: string, maxBytes: number): Promise<unknown> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > maxBytes) {
    throw new PiResourceBindingError("installed_manifest", "installed Pi package manifest is unsafe");
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new PiResourceBindingError("installed_manifest", "installed Pi package manifest changed while read");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== metadata.size || bytes.includes(0)) {
      throw new PiResourceBindingError("installed_manifest", "installed Pi package manifest is invalid");
    }
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await handle.close();
  }
}

function parseSelection(value: unknown, id: string): PiResourceSelection {
  if (value === undefined) return { skills: [], prompts: [], tools: [] };
  if (!isRecord(value)) throw new PiResourceBindingError("binding_selection", `${id} select must be an object`);
  rejectUnknown(value, ["skills", "prompts", "tools"], `${id} select`);
  return {
    skills: uniqueResourcePaths(value.skills, `${id} selected skills`),
    prompts: uniqueResourcePaths(value.prompts, `${id} selected prompts`),
    tools: uniqueIdentifiers(value.tools, `${id} selected tools`, `${id} selected tool`),
  };
}

function validateIntegrationSelection(input: {
  id: string;
  enabled: boolean;
  integration: PiResourceIntegration;
  resources: readonly PiResourceKind[];
  selection: PiResourceSelection;
  stages: readonly string[];
  personas: readonly string[];
}): void {
  const { id, enabled, integration, resources, selection, stages, personas } = input;
  if (selection.skills.length > 0 && !resources.includes("skill")) {
    throw new PiResourceBindingError("binding_selection_kind", `${id} selects skills without declaring skill resources`);
  }
  if (selection.prompts.length > 0 && !resources.includes("prompt")) {
    throw new PiResourceBindingError("binding_selection_kind", `${id} selects prompts without declaring prompt resources`);
  }
  if (selection.tools.length > 0 && (integration !== "explicit_tools" || !resources.includes("extension"))) {
    throw new PiResourceBindingError("binding_selection_kind", `${id} tool adapters require explicit_tools and extension resources`);
  }
  if (integration === "interactive_only" || integration === "not_recommended") {
    if (selection.skills.length + selection.prompts.length + selection.tools.length > 0 || stages.length > 0 || personas.length > 0) {
      throw new PiResourceBindingError("binding_interactive_scope", `${id} cannot declare autonomous selectors or eligibility`);
    }
    return;
  }
  if (!enabled) return;
  if (stages.length === 0 || personas.length === 0) {
    throw new PiResourceBindingError("binding_eligibility", `${id} enabled autonomous binding requires stages and personas`);
  }
  if (integration === "skills_only" && selection.skills.length + selection.prompts.length === 0) {
    throw new PiResourceBindingError("binding_selection", `${id} enabled skills_only binding requires exact selected resources`);
  }
  if (integration === "explicit_tools" && selection.tools.length === 0) {
    throw new PiResourceBindingError("binding_selection", `${id} enabled explicit_tools binding requires an exact Koni tool adapter`);
  }
}

function uniqueResourcePaths(value: unknown, label: string): string[] {
  const entries = stringArray(value ?? [], label).map((entry) => normalizeResourcePath(entry));
  return [...new Set(entries)].sort(compareUtf8);
}

function normalizeResourcePath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes("\u0000") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    /[*?{}[\]]/u.test(value)
  ) {
    throw new PiResourceBindingError("binding_resource_path", `resource selector ${JSON.stringify(value)} is not an exact safe path`);
  }
  return value;
}

function uniqueIdentifiers(value: unknown, arrayLabel: string, itemLabel: string): string[] {
  return [...new Set(stringArray(value ?? [], arrayLabel).map((item) => requiredIdentifier(item, itemLabel)))].sort(compareUtf8);
}

function isInstalledResource(value: InstalledPiPackageResource): boolean {
  if (!isRecord(value)) return false;
  if (!["extension", "skill", "prompt"].includes(String(value.kind))) return false;
  if (typeof value.relativePath !== "string" || typeof value.ambientEnabled !== "boolean") return false;
  try {
    return normalizeResourcePath(value.relativePath) === value.relativePath;
  } catch {
    return false;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new PiResourceBindingError("binding_unknown_field", `${label} has unknown fields: ${unknown.join(", ")}`);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new PiResourceBindingError("binding_array", `${label} must be a string array`);
  }
  return [...value] as string[];
}

function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new PiResourceBindingError("binding_identifier", `${label} is not a lowercase kebab identifier`);
  }
  return value;
}

function requiredPackage(value: unknown, label: string): string {
  if (typeof value !== "string" || !isPackageName(value)) throw new PiResourceBindingError("binding_package", `${label} is not an npm package name`);
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 8_192) {
    throw new PiResourceBindingError("binding_text", `${label} must be bounded nonempty text`);
  }
  return value;
}

function isPackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
