import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  OptionalPiResourceBinding,
  PiResourceBindingCatalog,
} from "../contracts/pi-resources.js";
import {
  KONI_TOOL_NAMES,
  koniToolSchemaHash,
  type KoniToolName,
} from "../pi/tool-catalog.js";
import type { LaunchResource } from "../pi/launch-spec.js";
import type {
  InstalledPiPackageReference,
  InstalledPiPackageResource,
} from "../profile/resource-bindings.js";
import {
  canonicalHash,
  compareUtf8,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";

export const PINNED_COMMUNITY_RESOURCES_PROTOCOL = "koni.pinned-community-resources.v1" as const;

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PINNED_BYTES = 16 * 1024 * 1024;
const MAX_PINNED_FILES = 512;
const MAX_DEPTH = 32;

export interface CommunityToolAdapterDefinition {
  /** Project config selects this stable Koni-owned id. */
  readonly id: string;
  readonly bindingId: string;
  readonly packageName: string;
  readonly toolName: Exclude<KoniToolName, "koni_submit_output">;
  /** Network adapters are permitted only through authority-backed configured checks. */
  readonly requiresNetwork: boolean;
}

export interface PinnedCommunityFile {
  readonly kind: "skill" | "prompt";
  readonly relativePath: string;
  readonly content: string;
  readonly sha256: Sha256Digest;
  readonly sizeBytes: number;
}

export interface PinnedCommunityToolAdapter extends CommunityToolAdapterDefinition {
  readonly schemaHash: Sha256Digest;
}

export interface PinnedCommunityBinding {
  readonly id: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly installedSource: string;
  readonly packageManifestSha256: Sha256Digest;
  readonly integration: "skills_only" | "explicit_tools";
  readonly stages: readonly string[];
  readonly personas: readonly string[];
  readonly requiresNetwork: boolean;
  readonly files: readonly PinnedCommunityFile[];
  readonly tools: readonly PinnedCommunityToolAdapter[];
  readonly bindingHash: Sha256Digest;
}

export interface PinnedCommunityResourceBundle {
  readonly protocol: typeof PINNED_COMMUNITY_RESOURCES_PROTOCOL;
  readonly bindings: Readonly<Record<string, PinnedCommunityBinding>>;
  readonly bundleHash: Sha256Digest;
}

export interface SelectedCommunityAttemptResources {
  readonly resources: readonly LaunchResource[];
  readonly toolNames: readonly KoniToolName[];
  readonly bindingIds: readonly string[];
}

export class CommunityResourceError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "CommunityResourceError";
    this.code = code;
  }
}

/**
 * Copy explicitly selected text resources and authority-adapter contracts into immutable run
 * state. Community extension modules are never imported, evaluated, or copied.
 */
export async function pinCommunityResourceBundle(options: {
  catalog: PiResourceBindingCatalog | undefined;
  installed: readonly InstalledPiPackageReference[];
  adapters?: readonly CommunityToolAdapterDefinition[];
}): Promise<PinnedCommunityResourceBundle> {
  const catalog = options.catalog;
  if (catalog === undefined || !catalog.bindings.some(({ enabled, integration }) =>
    enabled && integration !== "interactive_only" && integration !== "not_recommended")) {
    return createBundle(Object.create(null) as Record<string, PinnedCommunityBinding>);
  }
  const installed = uniqueInstalledPackages(options.installed);
  const adapters = uniqueAdapters(options.adapters ?? []);
  const bindings: Record<string, PinnedCommunityBinding> = Object.create(null) as Record<string, PinnedCommunityBinding>;
  let totalFiles = 0;
  let totalBytes = 0;

  for (const binding of catalog.bindings) {
    if (!binding.enabled || binding.integration === "interactive_only") continue;
    if (binding.integration === "not_recommended") {
      throw new CommunityResourceError("not_recommended", `binding ${binding.id} cannot enter an autonomous run`);
    }
    const packageReference = installed.get(binding.package);
    if (packageReference === undefined) {
      throw new CommunityResourceError(
        "package_unavailable",
        `enabled Pi resource binding ${binding.id} requires installed package ${binding.package}`,
      );
    }
    const pinned = await pinBinding(binding, packageReference, adapters);
    totalFiles += pinned.files.length;
    totalBytes += pinned.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (totalFiles > MAX_PINNED_FILES || totalBytes > MAX_PINNED_BYTES) {
      throw new CommunityResourceError(
        "bundle_limit",
        `selected Pi community resources exceed ${MAX_PINNED_FILES} files or ${MAX_PINNED_BYTES} bytes`,
      );
    }
    bindings[binding.id] = pinned;
  }
  return createBundle(bindings);
}

/** Revalidate a deserialized pinned bundle without consulting mutable package state. */
export function validatePinnedCommunityResourceBundle(value: unknown): PinnedCommunityResourceBundle {
  if (!isRecord(value) || value.protocol !== PINNED_COMMUNITY_RESOURCES_PROTOCOL || !isRecord(value.bindings)) {
    throw new CommunityResourceError("pinned_shape", "pinned community resource bundle has an invalid envelope");
  }
  const bindings: Record<string, PinnedCommunityBinding> = Object.create(null) as Record<string, PinnedCommunityBinding>;
  let totalFiles = 0;
  let totalBytes = 0;
  for (const [id, raw] of Object.entries(value.bindings).sort(([left], [right]) => compareUtf8(left, right))) {
    if (!isRecord(raw) || raw.id !== id || !Array.isArray(raw.files) || !Array.isArray(raw.tools)) {
      throw new CommunityResourceError("pinned_shape", `pinned community binding ${id} is invalid`);
    }
    const binding = structuredClone(raw) as unknown as PinnedCommunityBinding;
    validatePinnedBinding(binding);
    totalFiles += binding.files.length;
    totalBytes += binding.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (totalFiles > MAX_PINNED_FILES || totalBytes > MAX_PINNED_BYTES) {
      throw new CommunityResourceError("pinned_limit", "pinned community resource bundle exceeds its byte or file bound");
    }
    bindings[id] = binding;
  }
  const bundle = createBundle(bindings);
  if (value.bundleHash !== bundle.bundleHash) {
    throw new CommunityResourceError("pinned_hash", "pinned community resource bundle hash does not match its content");
  }
  return deepFreeze(bundle);
}

/** Select only bindings eligible for this exact immutable attempt. */
export function selectCommunityAttemptResources(options: {
  bundle: PinnedCommunityResourceBundle | undefined;
  personaId: string;
  stageIds: readonly string[];
  networkAccess: boolean;
}): SelectedCommunityAttemptResources {
  if (options.bundle === undefined) return { resources: [], toolNames: [], bindingIds: [] };
  const bundle = validatePinnedCommunityResourceBundle(options.bundle);
  const stages = new Set(options.stageIds);
  const resources: LaunchResource[] = [];
  const toolNames = new Set<KoniToolName>();
  const bindingIds: string[] = [];
  for (const binding of Object.values(bundle.bindings).sort((left, right) => compareUtf8(left.id, right.id))) {
    if (!binding.personas.includes(options.personaId) || !binding.stages.some((stage) => stages.has(stage))) continue;
    if (binding.requiresNetwork && !options.networkAccess) {
      throw new CommunityResourceError(
        "network_grant",
        `community binding ${binding.id} is eligible but this attempt has no compiler-issued network grant`,
      );
    }
    bindingIds.push(binding.id);
    for (const file of binding.files) {
      const resourceId = `community-${binding.id}-${digestBody(canonicalHash([
        binding.id,
        file.relativePath,
        file.sha256,
      ])).slice(0, 24)}`;
      const relativePath = `community/${binding.id}/${file.relativePath}`;
      resources.push({
        kind: file.kind,
        id: resourceId,
        relativePath,
        content: file.content,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
      });
      if (file.kind === "prompt") {
        const content = [
          `Compiler-selected prompt resource ${binding.packageName}/${file.relativePath}:`,
          file.content,
        ].join("\n\n");
        resources.push(launchResource(
          "append_system_prompt",
          `${resourceId}-instructions`,
          `${relativePath}.instructions.md`,
          content,
        ));
      }
    }
    for (const adapter of binding.tools) {
      if (adapter.requiresNetwork && !options.networkAccess) {
        throw new CommunityResourceError("network_grant", `tool adapter ${adapter.id} requires network authority`);
      }
      toolNames.add(adapter.toolName);
    }
  }
  resources.sort((left, right) => compareUtf8(`${left.id}\0${left.relativePath}`, `${right.id}\0${right.relativePath}`));
  return {
    resources,
    toolNames: KONI_TOOL_NAMES.filter((name) => toolNames.has(name)),
    bindingIds,
  };
}

async function pinBinding(
  binding: OptionalPiResourceBinding,
  installed: InstalledPiPackageReference,
  adapters: ReadonlyMap<string, CommunityToolAdapterDefinition>,
): Promise<PinnedCommunityBinding> {
  const packageRoot = await realpath(installed.packageRoot).catch(() => undefined);
  if (packageRoot === undefined || packageRoot !== installed.packageRoot) {
    throw new CommunityResourceError("package_root", `installed package ${installed.packageName} has no canonical root`);
  }
  const rootMetadata = await lstat(packageRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new CommunityResourceError("package_root", `installed package ${installed.packageName} root is unsafe`);
  }
  const manifestBefore = await readTextFile(packageRoot, "package.json");
  const manifest = parsePackageManifest(manifestBefore.content, installed);
  const resources = installedResourceMap(installed.resources);
  const files = new Map<string, PinnedCommunityFile>();
  for (const selected of binding.select.skills) {
    requireResolvedResource(resources, "skill", selected, binding.id);
    const closure = path.posix.basename(selected) === "SKILL.md"
      ? await readStableTextTree(packageRoot, path.posix.dirname(selected), "skill")
      : [await readPinnedFile(packageRoot, selected, "skill")];
    for (const file of closure) addPinnedFile(files, file, binding.id);
  }
  for (const selected of binding.select.prompts) {
    requireResolvedResource(resources, "prompt", selected, binding.id);
    if (path.posix.extname(selected).toLowerCase() !== ".md") {
      throw new CommunityResourceError("prompt_type", `selected prompt ${selected} is not Markdown`);
    }
    addPinnedFile(files, await readPinnedFile(packageRoot, selected, "prompt"), binding.id);
  }
  const tools = binding.select.tools.map((adapterId) => {
    const adapter = adapters.get(adapterId);
    if (
      adapter === undefined ||
      adapter.bindingId !== binding.id ||
      adapter.packageName !== binding.package ||
      adapter.requiresNetwork !== binding.requiresNetwork
    ) {
      throw new CommunityResourceError(
        "adapter_unavailable",
        `binding ${binding.id} has no exact Koni-owned compatibility adapter ${adapterId}`,
      );
    }
    if (adapter.requiresNetwork && adapter.toolName !== "koni_run_check") {
      throw new CommunityResourceError(
        "adapter_network",
        `network adapter ${adapter.id} is not routed through the authority check runner`,
      );
    }
    return {
      ...structuredClone(adapter),
      schemaHash: koniToolSchemaHash(adapter.toolName),
    };
  }).sort((left, right) => compareUtf8(left.id, right.id));
  const manifestAfter = await readTextFile(packageRoot, "package.json");
  if (manifestAfter.sha256 !== manifestBefore.sha256 || manifestAfter.content !== manifestBefore.content) {
    throw new CommunityResourceError("package_race", `installed package ${installed.packageName} changed while pinned`);
  }
  if (binding.integration !== "skills_only" && binding.integration !== "explicit_tools") {
    throw new CommunityResourceError("integration", `binding ${binding.id} is not autonomous`);
  }
  const material = {
    id: binding.id,
    packageName: installed.packageName,
    packageVersion: manifest.version,
    installedSource: installed.source,
    packageManifestSha256: manifestBefore.sha256,
    integration: binding.integration,
    stages: [...binding.stages],
    personas: [...binding.personas],
    requiresNetwork: binding.requiresNetwork,
    files: [...files.values()].sort((left, right) => compareUtf8(left.relativePath, right.relativePath)),
    tools,
  } as const;
  return deepFreeze({ ...material, bindingHash: canonicalHash(material) });
}

function createBundle(bindings: Record<string, PinnedCommunityBinding>): PinnedCommunityResourceBundle {
  const sorted = Object.fromEntries(
    Object.entries(bindings).sort(([left], [right]) => compareUtf8(left, right)),
  ) as Record<string, PinnedCommunityBinding>;
  const material = { protocol: PINNED_COMMUNITY_RESOURCES_PROTOCOL, bindings: sorted } as const;
  return deepFreeze({ ...material, bundleHash: canonicalHash(material) });
}

function validatePinnedBinding(binding: PinnedCommunityBinding): void {
  if (
    typeof binding.id !== "string" || !isIdentifier(binding.id) ||
    typeof binding.packageName !== "string" || !isPackageName(binding.packageName) ||
    typeof binding.packageVersion !== "string" || binding.packageVersion.length < 1 || binding.packageVersion.length > 256 ||
    typeof binding.installedSource !== "string" || binding.installedSource.length < 1 || binding.installedSource.length > 8_192 ||
    !isSha256Digest(binding.packageManifestSha256) ||
    !["skills_only", "explicit_tools"].includes(binding.integration) ||
    !isSortedIdentifiers(binding.stages) ||
    !isSortedIdentifiers(binding.personas) ||
    typeof binding.requiresNetwork !== "boolean"
  ) throw new CommunityResourceError("pinned_shape", `pinned community binding ${binding.id} has invalid metadata`);
  if (!isSha256Digest(binding.bindingHash)) {
    throw new CommunityResourceError("pinned_hash", `pinned community binding ${binding.id} has no valid hash`);
  }
  const filePaths = new Set<string>();
  for (const file of binding.files) {
    if (
      !isRecord(file) ||
      !["skill", "prompt"].includes(String(file.kind)) ||
      typeof file.relativePath !== "string" ||
      normalizeRelativePath(file.relativePath) !== file.relativePath ||
      typeof file.content !== "string" ||
      file.sizeBytes !== Buffer.byteLength(file.content, "utf8") ||
      file.sizeBytes < 1 || file.sizeBytes > MAX_FILE_BYTES ||
      rawSha256(file.content) !== file.sha256 ||
      filePaths.has(file.relativePath)
    ) throw new CommunityResourceError("pinned_file", `pinned community file in ${binding.id} is invalid`);
    if (file.kind === "prompt" && path.posix.extname(file.relativePath).toLowerCase() !== ".md") {
      throw new CommunityResourceError("pinned_file", `pinned community prompt in ${binding.id} is not Markdown`);
    }
    filePaths.add(file.relativePath);
  }
  const toolIds = new Set<string>();
  for (const tool of binding.tools) {
    if (
      !isRecord(tool) ||
      !isIdentifier(String(tool.id)) ||
      tool.bindingId !== binding.id ||
      tool.packageName !== binding.packageName ||
      !(KONI_TOOL_NAMES as readonly string[]).includes(tool.toolName) ||
      typeof tool.requiresNetwork !== "boolean" ||
      tool.requiresNetwork !== binding.requiresNetwork ||
      (tool.requiresNetwork && tool.toolName !== "koni_run_check") ||
      tool.schemaHash !== koniToolSchemaHash(tool.toolName as KoniToolName) ||
      toolIds.has(String(tool.id))
    ) throw new CommunityResourceError("pinned_tool", `pinned community tool in ${binding.id} is invalid`);
    toolIds.add(String(tool.id));
  }
  if (binding.integration === "skills_only" && binding.tools.length > 0) {
    throw new CommunityResourceError("pinned_tool", `skills-only binding ${binding.id} contains a tool adapter`);
  }
  const { bindingHash, ...material } = binding;
  if (canonicalHash(material) !== bindingHash) {
    throw new CommunityResourceError("pinned_hash", `pinned community binding ${binding.id} hash does not match`);
  }
}

function uniqueInstalledPackages(
  entries: readonly InstalledPiPackageReference[],
): ReadonlyMap<string, InstalledPiPackageReference> {
  const output = new Map<string, InstalledPiPackageReference>();
  for (const entry of entries) {
    if (output.has(entry.packageName)) {
      throw new CommunityResourceError("package_ambiguous", `installed Pi package ${entry.packageName} is ambiguous`);
    }
    output.set(entry.packageName, structuredClone(entry));
  }
  return output;
}

function uniqueAdapters(
  entries: readonly CommunityToolAdapterDefinition[],
): ReadonlyMap<string, CommunityToolAdapterDefinition> {
  const output = new Map<string, CommunityToolAdapterDefinition>();
  for (const adapter of entries) {
    if (
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(adapter.id) ||
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(adapter.bindingId) ||
      !(KONI_TOOL_NAMES as readonly string[]).includes(adapter.toolName) ||
      typeof adapter.requiresNetwork !== "boolean"
    ) throw new CommunityResourceError("adapter_shape", `community tool adapter ${adapter.id} is invalid`);
    if (output.has(adapter.id)) throw new CommunityResourceError("adapter_duplicate", `duplicate adapter ${adapter.id}`);
    output.set(adapter.id, structuredClone(adapter));
  }
  return output;
}

function installedResourceMap(
  resources: readonly InstalledPiPackageResource[],
): ReadonlySet<string> {
  return new Set(resources.map((resource) => `${resource.kind}\0${resource.relativePath}`));
}

function requireResolvedResource(
  resources: ReadonlySet<string>,
  kind: "skill" | "prompt",
  relativePath: string,
  bindingId: string,
): void {
  if (!resources.has(`${kind}\0${relativePath}`)) {
    throw new CommunityResourceError(
      "resource_unavailable",
      `binding ${bindingId} selected ${kind} ${relativePath}, but Pi did not resolve it from that package`,
    );
  }
}

async function readStableTextTree(
  packageRoot: string,
  relativeRoot: string,
  kind: "skill" | "prompt",
): Promise<PinnedCommunityFile[]> {
  const first = await readTextTree(packageRoot, relativeRoot, kind);
  const second = await readTextTree(packageRoot, relativeRoot, kind);
  if (canonicalHash(first) !== canonicalHash(second)) {
    throw new CommunityResourceError("package_race", `community resource tree ${relativeRoot} changed while pinned`);
  }
  return second;
}

async function readTextTree(
  packageRoot: string,
  relativeRoot: string,
  kind: "skill" | "prompt",
): Promise<PinnedCommunityFile[]> {
  const root = containedPath(packageRoot, relativeRoot);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new CommunityResourceError("resource_tree", `community resource directory ${relativeRoot} is unsafe`);
  }
  const output: PinnedCommunityFile[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new CommunityResourceError("resource_depth", `community resource tree ${relativeRoot} is too deep`);
    const entries: Dirent[] = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.includes("\u0000") || entry.name.includes("/") || entry.name.includes("\\")) {
        throw new CommunityResourceError("resource_path", `community resource tree ${relativeRoot} has an unsafe entry`);
      }
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new CommunityResourceError("resource_symlink", `community resource ${absolute} is a symlink`);
      if (metadata.isDirectory()) {
        await walk(absolute, depth + 1);
      } else if (metadata.isFile()) {
        const relativePath = normalizeRelativePath(path.relative(packageRoot, absolute));
        output.push(await readPinnedFile(packageRoot, relativePath, kind));
      } else {
        throw new CommunityResourceError("resource_type", `community resource ${absolute} is not a regular file`);
      }
    }
  };
  await walk(root, 0);
  return output.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
}

async function readPinnedFile(
  packageRoot: string,
  relativePath: string,
  kind: "skill" | "prompt",
): Promise<PinnedCommunityFile> {
  const file = await readTextFile(packageRoot, relativePath);
  return { kind, relativePath, ...file };
}

async function readTextFile(
  packageRoot: string,
  relativePath: string,
): Promise<{ content: string; sha256: Sha256Digest; sizeBytes: number }> {
  const absolute = containedPath(packageRoot, relativePath);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAX_FILE_BYTES) {
    throw new CommunityResourceError("resource_file", `community resource ${relativePath} is empty, oversized, or unsafe`);
  }
  const canonical = await realpath(absolute);
  if (canonical !== absolute || !isWithin(packageRoot, canonical)) {
    throw new CommunityResourceError("resource_escape", `community resource ${relativePath} escapes its package`);
  }
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new CommunityResourceError("resource_race", `community resource ${relativePath} changed while read`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== metadata.size || bytes.includes(0)) {
      throw new CommunityResourceError("resource_encoding", `community resource ${relativePath} is invalid`);
    }
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) {
      throw new CommunityResourceError("resource_encoding", `community resource ${relativePath} is not UTF-8 text`);
    }
    return { content, sha256: rawSha256(content), sizeBytes: bytes.byteLength };
  } finally {
    await handle.close();
  }
}

function parsePackageManifest(
  source: string,
  installed: InstalledPiPackageReference,
): { name: string; version: string } {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new CommunityResourceError("package_manifest", `package ${installed.packageName} has invalid package.json`); }
  if (!isRecord(value) || value.name !== installed.packageName || value.version !== installed.packageVersion) {
    throw new CommunityResourceError("package_identity", `package ${installed.packageName} identity changed after Pi resolved it`);
  }
  return { name: installed.packageName, version: installed.packageVersion };
}

function addPinnedFile(
  files: Map<string, PinnedCommunityFile>,
  file: PinnedCommunityFile,
  bindingId: string,
): void {
  const prior = files.get(file.relativePath);
  if (prior !== undefined && canonicalHash(prior) !== canonicalHash(file)) {
    throw new CommunityResourceError("resource_collision", `binding ${bindingId} resolved conflicting bytes at ${file.relativePath}`);
  }
  files.set(file.relativePath, file);
}

function containedPath(root: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const absolute = path.join(root, normalized);
  if (!isWithin(root, absolute)) throw new CommunityResourceError("resource_escape", `community resource ${relativePath} escapes its package`);
  return absolute;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.split(path.sep).join("/");
  if (
    normalized.length === 0 ||
    normalized.length > 4_096 ||
    path.posix.isAbsolute(normalized) ||
    path.posix.normalize(normalized) !== normalized ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) throw new CommunityResourceError("resource_path", `community resource path ${JSON.stringify(value)} is unsafe`);
  return normalized;
}

function launchResource(
  kind: LaunchResource["kind"],
  id: string,
  relativePath: string,
  content: string,
): LaunchResource {
  return {
    kind,
    id,
    relativePath,
    content,
    sha256: rawSha256(content),
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
}

function digestBody(value: Sha256Digest): string {
  return value.slice("sha256:".length);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value);
}

function isPackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u.test(value);
}

function isSortedIdentifiers(value: readonly string[]): boolean {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string" && isIdentifier(item)) &&
    value.length === new Set(value).size &&
    value.every((item, index) => index === 0 || compareUtf8(value[index - 1]!, item) < 0);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
