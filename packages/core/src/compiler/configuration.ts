import { TextDecoder } from "node:util";
import { satisfies, valid, validRange } from "semver";
import {
  COMPILED_CONFIGURATION_PROTOCOL,
  CONFIGURATION_REGISTRY_KINDS,
  PROFILE_CONFIGURATION_SCHEMA_VERSION,
  PROFILE_IMPORT_CATEGORIES,
  type CompiledAgentResource,
  type CompiledConfiguration,
  type CompiledConfigurationMaterial,
  type CompiledProfileModule,
  type CompiledRunType,
  type ConfigurationObject,
  type ConfigurationRegistryKind,
  type ProfileImportCategory,
} from "../contracts/configuration.js";
import type { PiResourceBindingCatalog } from "../contracts/pi-resources.js";
import type { ProfileBaselineFile } from "../contracts/profile-package.js";
import {
  canonicalHash,
  compareUtf8,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import {
  DiagnosticBag,
  pointer,
  validationFailure,
  validationSuccess,
  type CompilerDiagnostic,
  type ValidationResult,
} from "../shared/diagnostics.js";
import { parseStrictYamlObject, type StrictYamlLimits } from "../shared/yaml.js";
import {
  computeProfileBundleSha256,
  isNormalizedSafeRelativePath,
  validateProfilePackageManifest,
  verifyProfileBaseline,
  type VerifiedProfileBaseline,
} from "./profile-package.js";
import {
  parsePiResourceBindingValue,
  PiResourceBindingError,
} from "../profile/resource-bindings.js";
import { projectGraphSchemaDefinition } from "./graph-schema.js";
import { compileStateMachineCatalog } from "./rules.js";
import {
  compileExecutionSemanticCatalog,
  ExecutionSemanticCompilationError,
} from "./execution-semantics.js";
import { compileActionCatalog } from "./action-recipes.js";
import { compileConfigurationBehavior } from "./behavior.js";

const REQUIRED_IMPORT_CATEGORIES: readonly ProfileImportCategory[] = [
  "graph",
  "rules",
  "operations",
  "workflows",
  "actions",
  "checks",
  "personas",
  "reports",
  "cockpit",
];

const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CONFIGURATION_ENGINE_VERSION = "0.1.0";

const PROFILE_TOP_LEVEL_FIELDS = [
  "schema_version",
  "engine",
  "profile",
  "initialization",
  "git",
  "orchestration",
  "change_control",
  "reporting",
  "imports",
] as const;

const RUN_IDENTITY_FIELDS = ["schema_version", "id", "title", "description"] as const;
const RUN_BEHAVIOR_FIELDS = [
  "profile",
  "intake",
  "pipeline",
  "questions",
  "git",
  "run_card",
  "agents",
  "orchestration",
  "promotion",
  "planning",
  "instructions",
  "working_spec",
  "workspace",
] as const;
const RUN_SOURCE_FIELDS = [...RUN_IDENTITY_FIELDS, ...RUN_BEHAVIOR_FIELDS, "extends", "overrides"];

const MODULE_PAYLOADS: Readonly<Record<ProfileImportCategory, readonly string[]>> = {
  graph: ["node_types", "edge_types", "queries", "graph_constraints", "gate_policies"],
  rules: ["rules", "queries", "state_machines"],
  operations: ["operations"],
  workflows: ["workflows"],
  actions: ["actions"],
  checks: ["checks"],
  personas: ["personas"],
  reports: ["reports"],
  cockpit: ["views"],
  lifecycles: ["state_machines"],
};

const PAYLOAD_REGISTRIES: Readonly<Partial<Record<string, ConfigurationRegistryKind>>> = {
  node_types: "node_types",
  queries: "queries",
  graph_constraints: "graph_constraints",
  gate_policies: "gate_policies",
  rules: "rules",
  operations: "operations",
  workflows: "workflows",
  actions: "actions",
  checks: "checks",
  personas: "personas",
  reports: "reports",
  views: "views",
  state_machines: "state_machines",
};

const RUN_OVERRIDE_ROOTS = new Set<string>(RUN_BEHAVIOR_FIELDS);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

type MutableConfigurationValue =
  null | boolean | number | string | MutableConfigurationObject | MutableConfigurationValue[];

interface MutableConfigurationObject {
  [key: string]: MutableConfigurationValue;
}

interface LoadedConfigurationFile {
  path: string;
  sourceSha256: Sha256Digest;
  document: MutableConfigurationObject;
}

interface MutableCompiledModule {
  category: ProfileImportCategory;
  path: string;
  source_sha256: Sha256Digest;
  module?: { id: string; version: string };
  document: MutableConfigurationObject;
}

interface ResolvedRunTypeInternal {
  id: string;
  path: string;
  extends?: string;
  ancestry: string[];
  source: MutableConfigurationObject;
  document: MutableConfigurationObject;
  sha256: Sha256Digest;
}

interface RegistryState {
  records: Record<ConfigurationRegistryKind, Map<string, MutableConfigurationObject>>;
  edgeTypes: MutableConfigurationObject[];
  edgeKeys: Set<string>;
  locations: Map<MutableConfigurationObject, string>;
}

export interface CompileProfileConfigurationOptions {
  yamlLimits?: Partial<StrictYamlLimits>;
}

/**
 * Hash inventory plus copied bytes for one effective editable `.koni` tree.
 * The profile package manifest supplies lineage and frozen-default provenance;
 * `files` describes the project's current bytes and may differ from baseline.
 */
export interface AuthenticatedProjectConfigurationSource {
  manifest: VerifiedProfileBaseline["manifest"];
  files: readonly ProfileBaselineFile[];
  contents: ReadonlyMap<string, Uint8Array>;
}

/**
 * Compile one authenticated schema-2 profile package into the immutable value
 * consumed by Koni's authority service.
 *
 * The structural `VerifiedProfileBaseline` type is deliberately reverified at
 * this boundary. A caller cannot forge trust by constructing a matching object.
 */
export function compileProfileConfiguration(
  baseline: VerifiedProfileBaseline,
  options: CompileProfileConfigurationOptions = {},
): ValidationResult<CompiledConfiguration> {
  const verified = verifyProfileBaseline(baseline.manifest, baseline.files);
  if (!verified.ok) {
    return verified;
  }

  return compileProjectConfiguration(
    {
      manifest: verified.value.manifest,
      files: verified.value.manifest.baseline.files,
      contents: verified.value.files,
    },
    options,
  );
}

/** Compile an authenticated effective project tree without requiring it to be byte-identical to defaults. */
export function compileProjectConfiguration(
  source: AuthenticatedProjectConfigurationSource,
  options: CompileProfileConfigurationOptions = {},
): ValidationResult<CompiledConfiguration> {
  const manifest = validateProfilePackageManifest(source.manifest);
  if (!manifest.ok) {
    return manifest;
  }
  const effective = verifyEffectiveProjectFiles(source.files, source.contents);
  if (!effective.ok) {
    return effective;
  }

  const bag = new DiagnosticBag();
  bag.extend(manifest.diagnostics);
  bag.extend(effective.diagnostics);
  const projectSource: VerifiedProfileBaseline = {
    manifest: manifest.value,
    files: effective.value.contents,
  };
  const filesByPath = new Map(effective.value.files.map((file) => [file.path, file] as const));
  const loader = createLoader(projectSource, filesByPath, bag, options.yamlLimits);

  const profileFile = loader("profile.yaml", "config");
  const projectFile = loader("project.yaml", "config");
  if (profileFile === undefined || projectFile === undefined) {
    return validationFailure(bag.sorted());
  }

  const profile = validateProfileDocument(profileFile, projectSource, bag);
  const project = validateProjectDocument(projectFile, bag);
  if (profile === undefined || project === undefined) {
    return validationFailure(bag.sorted());
  }

  const registryState = createRegistryState();
  const modules = loadProfileModules(profile, loader, registryState, bag);
  const agents = loadAgentResources(projectSource, filesByPath, loader, registryState, bag);
  const runTypes = loadRunTypes(project, loader, bag);
  let piResourceBindings: PiResourceBindingCatalog | undefined;
  if (filesByPath.has("resources/pi-packages.yaml")) {
    const resourceFile = loader("resources/pi-packages.yaml", "config");
    if (resourceFile !== undefined) {
      try {
        piResourceBindings = parsePiResourceBindingValue(resourceFile.document);
      } catch (error) {
        const message = error instanceof PiResourceBindingError ? error.message : String(error);
        bag.error(
          "configuration.pi_resource_bindings",
          fileRoot("resources/pi-packages.yaml"),
          message,
        );
      }
    }
  }

  if (modules === undefined || agents === undefined || runTypes === undefined) {
    return validationFailure(bag.sorted());
  }

  const actionCatalog = compileActionCatalog(
    [...registryState.records.actions.entries()].map(([id, document]) => ({
      id,
      path: locationOf(registryState, document, pointer("/registries/actions", id)),
      document,
    })),
  );
  bag.extend(actionCatalog.diagnostics);
  validateCrossReferences(profile.document, runTypes, registryState, bag);
  const behavior = actionCatalog.ok
    ? compileConfigurationBehavior({
        profile: profile.document,
        project: project.document,
        runTypeOrder: project.runTypeOrder,
        runTypes: [...runTypes.values()],
        agents,
        personas: registryState.records.personas,
        actions: actionCatalog.value,
      })
    : undefined;
  if (behavior !== undefined) bag.extend(behavior.diagnostics);
  if (bag.hasErrors()) {
    return validationFailure(bag.sorted());
  }
  if (behavior === undefined || !behavior.ok) {
    return validationFailure(bag.sorted());
  }

  const immutableModules = createCategoryRecord<readonly CompiledProfileModule[]>(() => []);
  for (const category of PROFILE_IMPORT_CATEGORIES) {
    immutableModules[category] = modules[category];
  }
  const runTypeRecord: Record<string, CompiledRunType> = Object.create(null) as Record<
    string,
    CompiledRunType
  >;
  for (const runType of runTypes.values()) {
    runTypeRecord[runType.id] = runType;
  }
  const agentRecord: Record<string, CompiledAgentResource> = Object.create(null) as Record<
    string,
    CompiledAgentResource
  >;
  for (const [id, agent] of agents) {
    agentRecord[id] = agent;
  }

  const material: CompiledConfigurationMaterial = {
    protocol: COMPILED_CONFIGURATION_PROTOCOL,
    schema_version: PROFILE_CONFIGURATION_SCHEMA_VERSION,
    package: {
      name: manifest.value.package.name,
      version: manifest.value.package.version,
      profile_id: manifest.value.profile.id,
      profile_version: manifest.value.profile.version,
      profile_lineage: manifest.value.profile.lineage,
    },
    baseline_bundle_sha256: manifest.value.bundle_sha256,
    // The package digest authenticates both the editable baseline inventory and the migration
    // catalog that defines how older project overlays reach these bytes. An untouched effective
    // baseline must therefore retain the exact package digest; local edits still change the file
    // projection while remaining bound to the same migration catalog.
    effective_bundle_sha256: computeProfileBundleSha256(
      effective.value.files,
      manifest.value.migrations,
    ),
    profile: profile.document,
    project: project.document,
    modules: immutableModules,
    run_type_order: [...project.runTypeOrder],
    run_types: runTypeRecord,
    agents: agentRecord,
    ...(piResourceBindings === undefined ? {} : { pi_resource_bindings: piResourceBindings }),
    edge_types: registryState.edgeTypes,
    registries: materializeRegistries(registryState.records),
    behavior: behavior.value,
  };
  const configuration: CompiledConfiguration = {
    ...material,
    configuration_sha256: canonicalHash(material),
  };
  // Configuration acceptance must mean every compiled run can instantiate its
  // graph, including run types the operator has not selected yet. Keeping the
  // graph runtime as the semantic authority avoids a second hand-written
  // schema validator while surfacing its failures at the editable config seam.
  const graphSchema = projectGraphSchemaDefinition(configuration);
  bag.extend(graphSchema.diagnostics);
  const stateMachines = compileStateMachineCatalog(configuration);
  bag.extend(stateMachines.diagnostics);
  try {
    compileExecutionSemanticCatalog(configuration);
  } catch (error) {
    if (error instanceof ExecutionSemanticCompilationError) {
      bag.error(error.code, error.path, error.message);
    } else {
      bag.error(
        "execution.internal_failure",
        "/registries",
        "execution-semantics compilation failed at a non-diagnostic boundary",
      );
    }
  }
  if (bag.hasErrors()) return validationFailure(bag.sorted());
  return validationSuccess(deepFreeze(configuration), bag.sorted());
}

const EFFECTIVE_FILE_KINDS = new Set<ProfileBaselineFile["kind"]>([
  "config",
  "agent",
  "skill",
  "prompt",
  "other",
]);
const MAX_EFFECTIVE_FILES = 16_384;

function verifyEffectiveProjectFiles(
  files: readonly ProfileBaselineFile[],
  contents: ReadonlyMap<string, Uint8Array>,
): ValidationResult<{
  files: readonly ProfileBaselineFile[];
  contents: ReadonlyMap<string, Uint8Array>;
}> {
  const bag = new DiagnosticBag();
  if (!Array.isArray(files)) {
    bag.error(
      "project_files.inventory",
      "/project_files",
      "project file inventory must be an array",
    );
    return validationFailure(bag.sorted());
  }
  if (files.length === 0 || files.length > MAX_EFFECTIVE_FILES) {
    bag.error(
      "project_files.count",
      "/project_files",
      "project file inventory has an invalid number of entries",
    );
  }
  const normalized: ProfileBaselineFile[] = [];
  const expected = new Set<string>();
  let previousPath: string | undefined;
  for (const [index, unknownFile] of (files as readonly unknown[]).entries()) {
    const pathRoot = pointer("/project_files", index);
    if (!isPlainRecord(unknownFile)) {
      bag.error("project_files.entry", pathRoot, "project file descriptor must be a mapping");
      continue;
    }
    for (const key of Object.keys(unknownFile)) {
      if (!["path", "sha256", "size_bytes", "kind"].includes(key)) {
        bag.error(
          "project_files.unknown_field",
          pointer(pathRoot, key),
          "project file descriptor contains an unknown field",
        );
      }
    }
    const path = unknownFile.path;
    const sha256 = unknownFile.sha256;
    const sizeBytes = unknownFile.size_bytes;
    const kind = unknownFile.kind;
    if (typeof path !== "string" || !isNormalizedSafeRelativePath(path)) {
      bag.error(
        "project_files.path",
        pointer(pathRoot, "path"),
        "project file path is not a safe normalized relative path",
      );
      continue;
    }
    if (previousPath !== undefined && compareUtf8(previousPath, path) >= 0) {
      bag.error(
        "project_files.order",
        pointer(pathRoot, "path"),
        "project file descriptors must be unique and UTF-8 sorted",
      );
    }
    previousPath = path;
    if (expected.has(path)) {
      bag.error(
        "project_files.duplicate",
        pointer(pathRoot, "path"),
        "project file path is duplicated",
      );
    }
    expected.add(path);
    if (!isSha256Digest(sha256)) {
      bag.error(
        "project_files.sha256",
        pointer(pathRoot, "sha256"),
        "project file digest must be canonical SHA-256",
      );
    }
    if (!Number.isSafeInteger(sizeBytes) || typeof sizeBytes !== "number" || sizeBytes < 0) {
      bag.error(
        "project_files.size",
        pointer(pathRoot, "size_bytes"),
        "project file size must be a nonnegative safe integer",
      );
    }
    if (
      typeof kind !== "string" ||
      !EFFECTIVE_FILE_KINDS.has(kind as ProfileBaselineFile["kind"])
    ) {
      bag.error(
        "project_files.kind",
        pointer(pathRoot, "kind"),
        "project file kind is not supported",
      );
    }
    if (
      isSha256Digest(sha256) &&
      typeof sizeBytes === "number" &&
      Number.isSafeInteger(sizeBytes) &&
      sizeBytes >= 0 &&
      typeof kind === "string" &&
      EFFECTIVE_FILE_KINDS.has(kind as ProfileBaselineFile["kind"])
    ) {
      normalized.push({
        path,
        sha256,
        size_bytes: sizeBytes,
        kind: kind as ProfileBaselineFile["kind"],
      });
    }
  }

  const copied = new Map<string, Uint8Array>();
  let actualCount = 0;
  try {
    for (const [path, value] of contents) {
      actualCount += 1;
      if (actualCount > MAX_EFFECTIVE_FILES) {
        bag.error(
          "project_files.count",
          "/project_files",
          "project file content map exceeds the configured entry limit",
        );
        break;
      }
      if (typeof path !== "string" || !isNormalizedSafeRelativePath(path)) {
        bag.error(
          "project_files.content_path",
          "/project_files",
          "project file content map contains an unsafe path",
        );
        continue;
      }
      if (!(value instanceof Uint8Array)) {
        bag.error(
          "project_files.content_type",
          pointer("/project_files", path),
          "project file content must be a byte array",
        );
        continue;
      }
      const bytes = Uint8Array.from(value);
      copied.set(path, bytes);
      if (!expected.has(path)) {
        bag.error(
          "project_files.unexpected",
          pointer("/project_files", path),
          "project file content is not present in the authenticated inventory",
        );
      }
    }
  } catch {
    bag.error(
      "project_files.contents",
      "/project_files",
      "project file content map could not be read safely",
    );
  }

  const descriptors = new Map(normalized.map((file) => [file.path, file] as const));
  for (const path of [...expected].sort(compareUtf8)) {
    const descriptor = descriptors.get(path);
    const bytes = copied.get(path);
    if (descriptor === undefined || bytes === undefined) {
      if (bytes === undefined) {
        bag.error(
          "project_files.missing",
          pointer("/project_files", path),
          "authenticated project file content is missing",
        );
      }
      continue;
    }
    if (bytes.byteLength !== descriptor.size_bytes) {
      bag.error(
        "project_files.size_mismatch",
        pointer("/project_files", path),
        "project file size does not match its authenticated inventory",
      );
    }
    if (rawSha256(bytes) !== descriptor.sha256) {
      bag.error(
        "project_files.hash_mismatch",
        pointer("/project_files", path),
        "project file digest does not match its authenticated inventory",
      );
    }
  }
  if (bag.hasErrors()) {
    return validationFailure(bag.sorted());
  }
  return validationSuccess({ files: normalized, contents: copied }, bag.sorted());
}

function createLoader(
  baseline: VerifiedProfileBaseline,
  filesByPath: ReadonlyMap<string, ProfileBaselineFile>,
  bag: DiagnosticBag,
  yamlLimits: Partial<StrictYamlLimits> | undefined,
): (path: string, kind: ProfileBaselineFile["kind"]) => LoadedConfigurationFile | undefined {
  const cache = new Map<string, LoadedConfigurationFile>();
  return (path, kind) => {
    const existing = cache.get(path);
    if (existing !== undefined) {
      const descriptor = filesByPath.get(path);
      if (descriptor?.kind !== kind) {
        bag.error(
          "configuration.file_kind",
          fileRoot(path),
          "configuration file has the wrong manifest kind",
        );
        return undefined;
      }
      return existing;
    }
    if (!isNormalizedSafeRelativePath(path)) {
      bag.error(
        "configuration.path",
        fileRoot(path),
        "configuration path is not a safe normalized relative path",
      );
      return undefined;
    }
    const descriptor = filesByPath.get(path);
    if (descriptor === undefined) {
      bag.error(
        "configuration.unlisted_file",
        fileRoot(path),
        "configuration path is not authenticated by the package manifest",
      );
      return undefined;
    }
    if (descriptor.kind !== kind) {
      bag.error(
        "configuration.file_kind",
        fileRoot(path),
        "configuration file has the wrong manifest kind",
      );
      return undefined;
    }
    const bytes = baseline.files.get(path);
    if (bytes === undefined) {
      bag.error("configuration.missing_file", fileRoot(path), "configuration file is missing");
      return undefined;
    }
    let source: string;
    try {
      source = decoder.decode(bytes);
    } catch {
      bag.error("configuration.utf8", fileRoot(path), "configuration file is not valid UTF-8");
      return undefined;
    }
    const parsed = parseStrictYamlObject(source, yamlLimits);
    bag.extend(parsed.diagnostics.map((diagnostic) => rebaseDiagnostic(path, diagnostic)));
    if (!parsed.ok) {
      return undefined;
    }
    const file = {
      path,
      sourceSha256: descriptor.sha256,
      document: toMutableObject(parsed.value),
    };
    cache.set(path, file);
    return file;
  };
}

function rebaseDiagnostic(path: string, diagnostic: CompilerDiagnostic): CompilerDiagnostic {
  return {
    ...diagnostic,
    path: diagnostic.path === "" ? fileRoot(path) : `${fileRoot(path)}${diagnostic.path}`,
  };
}

function fileRoot(path: string): string {
  return pointer("/files", path);
}

function validateProfileDocument(
  file: LoadedConfigurationFile,
  baseline: VerifiedProfileBaseline,
  bag: DiagnosticBag,
):
  | {
      document: MutableConfigurationObject;
      imports: Record<ProfileImportCategory, string[]>;
    }
  | undefined {
  const rootPath = fileRoot(file.path);
  const root = exactRecord(file.document, rootPath, PROFILE_TOP_LEVEL_FIELDS, bag);
  const schemaVersion = requiredString(root, "schema_version", rootPath, bag);
  if (schemaVersion !== undefined && schemaVersion !== PROFILE_CONFIGURATION_SCHEMA_VERSION) {
    bag.error(
      "configuration.schema_version",
      pointer(rootPath, "schema_version"),
      "profile schema version is not supported",
    );
  }
  const engine = requiredString(root, "engine", rootPath, bag);
  if (engine !== undefined) {
    const normalizedRange = engine.replaceAll(",", " ");
    if (
      validRange(normalizedRange) === null ||
      !satisfies(CONFIGURATION_ENGINE_VERSION, normalizedRange)
    ) {
      bag.error(
        "configuration.engine_range",
        pointer(rootPath, "engine"),
        `engine range must include native configuration engine ${CONFIGURATION_ENGINE_VERSION}`,
      );
    }
  }

  const identity = requiredExactRecord(
    root,
    "profile",
    rootPath,
    ["id", "version", "description"],
    bag,
  );
  const profileId =
    identity === undefined
      ? undefined
      : requiredString(identity, "id", pointer(rootPath, "profile"), bag);
  const profileVersion =
    identity === undefined
      ? undefined
      : requiredString(identity, "version", pointer(rootPath, "profile"), bag);
  if (identity !== undefined && identity.description !== undefined) {
    optionalString(identity, "description", pointer(rootPath, "profile"), bag);
  }
  if (profileId !== undefined && profileId !== baseline.manifest.profile.id) {
    bag.error(
      "configuration.profile_id",
      `${rootPath}/profile/id`,
      "profile id does not match the package manifest",
    );
  }
  if (profileVersion !== undefined && profileVersion !== baseline.manifest.profile.version) {
    bag.error(
      "configuration.profile_version",
      `${rootPath}/profile/version`,
      "profile version does not match the package manifest",
    );
  }

  for (const field of ["initialization", "git", "orchestration"] as const) {
    requiredRecord(root, field, rootPath, bag);
  }
  for (const field of ["change_control", "reporting"] as const) {
    if (root[field] !== undefined) {
      expectRecord(root[field], pointer(rootPath, field), bag);
    }
  }

  const importsRecord = requiredExactRecord(
    root,
    "imports",
    rootPath,
    PROFILE_IMPORT_CATEGORIES,
    bag,
  );
  if (importsRecord === undefined) {
    return undefined;
  }
  const imports = createCategoryRecord<string[]>(() => []);
  const seenPaths = new Set<string>();
  for (const category of PROFILE_IMPORT_CATEGORIES) {
    const value = importsRecord[category];
    if (value === undefined) {
      if (REQUIRED_IMPORT_CATEGORIES.includes(category)) {
        bag.error(
          "configuration.missing_import",
          pointer(pointer(rootPath, "imports"), category),
          "required profile import category is missing",
        );
      }
      continue;
    }
    const paths = stringArray(value, pointer(pointer(rootPath, "imports"), category), bag);
    if (paths === undefined) {
      continue;
    }
    if (paths.length === 0 && REQUIRED_IMPORT_CATEGORIES.includes(category)) {
      bag.error(
        "configuration.empty_import",
        pointer(pointer(rootPath, "imports"), category),
        "required profile import category must not be empty",
      );
    }
    for (const [index, path] of paths.entries()) {
      const location = pointer(pointer(pointer(rootPath, "imports"), category), index);
      if (!isNormalizedSafeRelativePath(path)) {
        bag.error(
          "configuration.import_path",
          location,
          "profile import is not a safe normalized relative path",
        );
        continue;
      }
      if (seenPaths.has(path)) {
        bag.error(
          "configuration.duplicate_import",
          location,
          "profile import path is referenced more than once",
        );
        continue;
      }
      seenPaths.add(path);
      imports[category].push(path);
    }
  }
  if (
    bag.hasErrors() ||
    schemaVersion !== PROFILE_CONFIGURATION_SCHEMA_VERSION ||
    profileId === undefined ||
    profileVersion === undefined
  ) {
    return undefined;
  }
  return { document: root, imports };
}

function validateProjectDocument(
  file: LoadedConfigurationFile,
  bag: DiagnosticBag,
):
  | {
      document: MutableConfigurationObject;
      defaultRunType: string;
      runTypeOrder: string[];
      entries: Map<string, string>;
    }
  | undefined {
  const rootPath = fileRoot(file.path);
  const root = exactRecord(
    file.document,
    rootPath,
    ["schema_version", "project", "default_run_type", "run_types"],
    bag,
  );
  const schemaVersion = requiredString(root, "schema_version", rootPath, bag);
  if (schemaVersion !== undefined && schemaVersion !== PROFILE_CONFIGURATION_SCHEMA_VERSION) {
    bag.error(
      "configuration.schema_version",
      pointer(rootPath, "schema_version"),
      "project schema version is not supported",
    );
  }
  const project = requiredExactRecord(
    root,
    "project",
    rootPath,
    ["id", "title", "description"],
    bag,
  );
  if (project !== undefined) {
    requiredIdentifier(project, "id", pointer(rootPath, "project"), bag);
    requiredString(project, "title", pointer(rootPath, "project"), bag);
    if (project.description !== undefined) {
      optionalString(project, "description", pointer(rootPath, "project"), bag);
    }
  }
  const defaultRunType = requiredIdentifier(root, "default_run_type", rootPath, bag);
  const entriesValue = root.run_types;
  const entriesArray = expectArray(entriesValue, pointer(rootPath, "run_types"), bag);
  const entries = new Map<string, string>();
  const seenPaths = new Set<string>();
  const runTypeOrder: string[] = [];
  if (entriesArray !== undefined) {
    if (entriesArray.length === 0) {
      bag.error(
        "configuration.empty_run_types",
        pointer(rootPath, "run_types"),
        "project catalog must contain at least one run type",
      );
    }
    for (const [index, value] of entriesArray.entries()) {
      const entryPath = pointer(pointer(rootPath, "run_types"), index);
      const entry = exactRecord(value, entryPath, ["id", "path"], bag);
      const id = requiredIdentifier(entry, "id", entryPath, bag);
      const path = requiredString(entry, "path", entryPath, bag);
      if (id === undefined || path === undefined) {
        continue;
      }
      if (!isNormalizedSafeRelativePath(path)) {
        bag.error(
          "configuration.run_type_path",
          pointer(entryPath, "path"),
          "run type path is not a safe normalized relative path",
        );
        continue;
      }
      if (entries.has(id)) {
        bag.error(
          "configuration.duplicate_run_type",
          pointer(entryPath, "id"),
          "run type id is duplicated in the project catalog",
        );
        continue;
      }
      if (seenPaths.has(path)) {
        bag.error(
          "configuration.duplicate_run_type_path",
          pointer(entryPath, "path"),
          "run type path is referenced more than once",
        );
        continue;
      }
      entries.set(id, path);
      seenPaths.add(path);
      runTypeOrder.push(id);
    }
  }
  if (defaultRunType !== undefined && !entries.has(defaultRunType)) {
    bag.error(
      "configuration.default_run_type",
      pointer(rootPath, "default_run_type"),
      "default run type is not present in the project catalog",
    );
  }
  if (
    bag.hasErrors() ||
    schemaVersion !== PROFILE_CONFIGURATION_SCHEMA_VERSION ||
    defaultRunType === undefined ||
    entries.size === 0
  ) {
    return undefined;
  }
  return { document: root, defaultRunType, runTypeOrder, entries };
}

function loadProfileModules(
  profile: {
    document: MutableConfigurationObject;
    imports: Record<ProfileImportCategory, string[]>;
  },
  loader: (path: string, kind: ProfileBaselineFile["kind"]) => LoadedConfigurationFile | undefined,
  registryState: RegistryState,
  bag: DiagnosticBag,
): Record<ProfileImportCategory, MutableCompiledModule[]> | undefined {
  const modules = createCategoryRecord<MutableCompiledModule[]>(() => []);
  const moduleIds = new Set<string>();
  for (const category of PROFILE_IMPORT_CATEGORIES) {
    for (const path of profile.imports[category]) {
      const file = loader(path, "config");
      if (file === undefined) {
        continue;
      }
      const module = validateModuleDocument(file, category, moduleIds, registryState, bag);
      if (module !== undefined) {
        modules[category].push(module);
      }
    }
  }
  return bag.hasErrors() ? undefined : modules;
}

function validateModuleDocument(
  file: LoadedConfigurationFile,
  category: ProfileImportCategory,
  moduleIds: Set<string>,
  registryState: RegistryState,
  bag: DiagnosticBag,
): MutableCompiledModule | undefined {
  const rootPath = fileRoot(file.path);
  const payloadKeys = MODULE_PAYLOADS[category];
  const hasEnvelope =
    file.document.schema_version !== undefined || file.document.module !== undefined;
  const allowed = hasEnvelope ? ["schema_version", "module", ...payloadKeys] : payloadKeys;
  const root = exactRecord(file.document, rootPath, allowed, bag);
  let moduleIdentity: { id: string; version: string } | undefined;
  if (hasEnvelope) {
    const schemaVersion = requiredString(root, "schema_version", rootPath, bag);
    if (schemaVersion !== undefined && schemaVersion !== PROFILE_CONFIGURATION_SCHEMA_VERSION) {
      bag.error(
        "configuration.schema_version",
        pointer(rootPath, "schema_version"),
        "module schema version is not supported",
      );
    }
    const identity = requiredExactRecord(root, "module", rootPath, ["id", "version"], bag);
    if (identity !== undefined) {
      const id = requiredIdentifier(identity, "id", pointer(rootPath, "module"), bag);
      const version = requiredString(identity, "version", pointer(rootPath, "module"), bag);
      if (version !== undefined && valid(version) === null) {
        bag.error(
          "configuration.module_version",
          `${rootPath}/module/version`,
          "module version must be exact semantic versioning",
        );
      }
      if (id !== undefined) {
        if (moduleIds.has(id)) {
          bag.error(
            "configuration.duplicate_module",
            `${rootPath}/module/id`,
            "module id is duplicated across profile imports",
          );
        } else {
          moduleIds.add(id);
        }
      }
      if (id !== undefined && version !== undefined && valid(version) !== null) {
        moduleIdentity = { id, version };
      }
    }
  }

  let payloadCount = 0;
  for (const payloadKey of payloadKeys) {
    const value = root[payloadKey];
    if (value === undefined) {
      continue;
    }
    payloadCount += 1;
    const items = expectArray(value, pointer(rootPath, payloadKey), bag);
    if (items === undefined) {
      continue;
    }
    registerPayloadItems(payloadKey, items, rootPath, registryState, bag);
  }
  if (payloadCount === 0) {
    bag.error(
      "configuration.empty_module",
      rootPath,
      "profile module contains no payload for its import category",
    );
  }
  if (bag.hasErrors()) {
    return undefined;
  }
  return {
    category,
    path: file.path,
    source_sha256: file.sourceSha256,
    ...(moduleIdentity === undefined ? {} : { module: moduleIdentity }),
    document: root,
  };
}

function registerPayloadItems(
  payloadKey: string,
  items: MutableConfigurationValue[],
  rootPath: string,
  state: RegistryState,
  bag: DiagnosticBag,
): void {
  if (payloadKey === "edge_types") {
    for (const [index, value] of items.entries()) {
      const itemPath = pointer(pointer(rootPath, payloadKey), index);
      const edge = expectRecord(value, itemPath, bag);
      if (edge === undefined) {
        continue;
      }
      const source = requiredIdentifier(edge, "source", itemPath, bag);
      const relation = requiredIdentifier(edge, "relation", itemPath, bag);
      stringArray(edge.targets, pointer(itemPath, "targets"), bag);
      if (source !== undefined && relation !== undefined) {
        const key = JSON.stringify([source, relation]);
        if (state.edgeKeys.has(key)) {
          bag.error(
            "configuration.duplicate_edge_type",
            itemPath,
            "edge type source and relation are duplicated",
          );
        } else {
          state.edgeKeys.add(key);
          state.edgeTypes.push(edge);
          state.locations.set(edge, itemPath);
        }
      }
    }
    return;
  }
  const registryKind = PAYLOAD_REGISTRIES[payloadKey];
  if (registryKind === undefined) {
    return;
  }
  const registry = state.records[registryKind];
  for (const [index, value] of items.entries()) {
    const itemPath = pointer(pointer(rootPath, payloadKey), index);
    const item = expectRecord(value, itemPath, bag);
    if (item === undefined) {
      continue;
    }
    const id = requiredIdentifier(item, "id", itemPath, bag);
    if (id === undefined) {
      continue;
    }
    if (registry.has(id)) {
      bag.error(
        "configuration.duplicate_id",
        pointer(itemPath, "id"),
        `duplicate ${registryKind} id`,
      );
      continue;
    }
    registry.set(id, item);
    state.locations.set(item, itemPath);
  }
}

function loadAgentResources(
  baseline: VerifiedProfileBaseline,
  filesByPath: ReadonlyMap<string, ProfileBaselineFile>,
  loader: (path: string, kind: ProfileBaselineFile["kind"]) => LoadedConfigurationFile | undefined,
  registryState: RegistryState,
  bag: DiagnosticBag,
): Map<string, CompiledAgentResource> | undefined {
  const agents = new Map<string, CompiledAgentResource>();
  const paths = [...filesByPath.values()]
    .filter((file) => file.kind === "agent")
    .map((file) => file.path)
    .sort(compareUtf8);
  for (const path of paths) {
    const file = loader(path, "agent");
    if (file === undefined) {
      continue;
    }
    const rootPath = fileRoot(path);
    const root = exactRecord(
      file.document,
      rootPath,
      [
        "schema_version",
        "id",
        "description",
        "instructions",
        "provider",
        "model",
        "thinking_level",
        "capabilities",
      ],
      bag,
    );
    const schemaVersion = requiredString(root, "schema_version", rootPath, bag);
    if (schemaVersion !== undefined && schemaVersion !== PROFILE_CONFIGURATION_SCHEMA_VERSION) {
      bag.error(
        "configuration.schema_version",
        pointer(rootPath, "schema_version"),
        "agent schema version is not supported",
      );
    }
    const id = requiredIdentifier(root, "id", rootPath, bag);
    requiredString(root, "description", rootPath, bag);
    const instructions = requiredExactRecord(
      root,
      "instructions",
      rootPath,
      ["source", "text", "path"],
      bag,
    );
    if (instructions !== undefined) {
      const source = requiredString(instructions, "source", pointer(rootPath, "instructions"), bag);
      if (source === "inline") {
        requiredString(instructions, "text", pointer(rootPath, "instructions"), bag);
        if (instructions.path !== undefined) {
          bag.error(
            "configuration.agent_instructions",
            `${rootPath}/instructions/path`,
            "inline agent instructions must not declare a path",
          );
        }
      } else if (source === "file") {
        const instructionPath = requiredString(
          instructions,
          "path",
          pointer(rootPath, "instructions"),
          bag,
        );
        if (instructionPath !== undefined && !isNormalizedSafeRelativePath(instructionPath)) {
          bag.error(
            "configuration.agent_instruction_path",
            `${rootPath}/instructions/path`,
            "agent instruction path is not safe and normalized",
          );
        }
        if (instructions.text !== undefined) {
          bag.error(
            "configuration.agent_instructions",
            `${rootPath}/instructions/text`,
            "file agent instructions must not contain inline text",
          );
        }
      } else if (source !== undefined) {
        bag.error(
          "configuration.agent_instructions",
          `${rootPath}/instructions/source`,
          "agent instruction source is not supported",
        );
      }
    }
    requiredString(root, "provider", rootPath, bag);
    requiredString(root, "model", rootPath, bag);
    requiredThinkingLevel(root, "thinking_level", rootPath, bag);
    requiredRecord(root, "capabilities", rootPath, bag);
    if (id === undefined) {
      continue;
    }
    if (path !== `agents/${id}.yaml`) {
      bag.error("configuration.agent_path", rootPath, "agent path must be agents/<id>.yaml");
    }
    if (agents.has(id)) {
      bag.error("configuration.duplicate_agent", pointer(rootPath, "id"), "agent id is duplicated");
      continue;
    }
    const agent: CompiledAgentResource = {
      id,
      path,
      source_sha256: file.sourceSha256,
      document: root,
    };
    agents.set(id, agent);
    registryState.records.agents.set(id, root);
    registryState.locations.set(root, rootPath);
  }
  void baseline;
  return bag.hasErrors() ? undefined : agents;
}

function loadRunTypes(
  project: {
    document: MutableConfigurationObject;
    defaultRunType: string;
    runTypeOrder: string[];
    entries: Map<string, string>;
  },
  loader: (path: string, kind: ProfileBaselineFile["kind"]) => LoadedConfigurationFile | undefined,
  bag: DiagnosticBag,
): Map<string, ResolvedRunTypeInternal> | undefined {
  const sources = new Map<string, { path: string; document: MutableConfigurationObject }>();
  for (const id of project.runTypeOrder) {
    const path = project.entries.get(id);
    if (path === undefined) {
      continue;
    }
    const file = loader(path, "config");
    if (file === undefined) {
      continue;
    }
    const document = validateRunTypeSource(file, id, bag);
    if (document !== undefined) {
      sources.set(id, { path, document });
    }
  }
  if (bag.hasErrors() || sources.size !== project.entries.size) {
    return undefined;
  }

  const resolved = new Map<string, ResolvedRunTypeInternal>();
  const visiting: string[] = [];
  for (const id of project.runTypeOrder) {
    resolveRunType(id, sources, resolved, visiting, bag);
  }
  void project.defaultRunType;
  return bag.hasErrors() ? undefined : resolved;
}

function validateRunTypeSource(
  file: LoadedConfigurationFile,
  catalogId: string,
  bag: DiagnosticBag,
): MutableConfigurationObject | undefined {
  const rootPath = fileRoot(file.path);
  const root = exactRecord(file.document, rootPath, RUN_SOURCE_FIELDS, bag);
  const schemaVersion = requiredString(root, "schema_version", rootPath, bag);
  if (schemaVersion !== undefined && schemaVersion !== PROFILE_CONFIGURATION_SCHEMA_VERSION) {
    bag.error(
      "configuration.schema_version",
      pointer(rootPath, "schema_version"),
      "run type schema version is not supported",
    );
  }
  const id = requiredIdentifier(root, "id", rootPath, bag);
  requiredString(root, "title", rootPath, bag);
  if (root.description !== undefined) {
    optionalString(root, "description", rootPath, bag);
  }
  if (id !== undefined && id !== catalogId) {
    bag.error(
      "configuration.run_type_id",
      pointer(rootPath, "id"),
      "run type document id does not match its catalog entry",
    );
  }

  const parent =
    root.extends === undefined ? undefined : optionalIdentifier(root, "extends", rootPath, bag);
  const overrides =
    root.overrides === undefined
      ? []
      : expectArray(root.overrides, pointer(rootPath, "overrides"), bag);
  if (parent !== undefined) {
    const inline = RUN_BEHAVIOR_FIELDS.filter((field) => root[field] !== undefined);
    if (inline.length > 0) {
      bag.error(
        "configuration.derived_inline_behavior",
        rootPath,
        "derived run type may alter behavior only through overrides",
      );
    }
    if (overrides !== undefined) {
      overrides.forEach((override, index) =>
        validateOverrideShape(override, pointer(pointer(rootPath, "overrides"), index), bag),
      );
    }
  } else {
    if (overrides !== undefined && overrides.length > 0) {
      bag.error(
        "configuration.base_overrides",
        pointer(rootPath, "overrides"),
        "base run type may not declare overrides",
      );
    }
    const behavior = extractBehavior(root);
    validateRunBehavior(behavior, rootPath, bag);
  }
  if (
    bag.hasErrors() ||
    schemaVersion !== PROFILE_CONFIGURATION_SCHEMA_VERSION ||
    id !== catalogId
  ) {
    return undefined;
  }
  return root;
}

function resolveRunType(
  id: string,
  sources: ReadonlyMap<string, { path: string; document: MutableConfigurationObject }>,
  resolved: Map<string, ResolvedRunTypeInternal>,
  visiting: string[],
  bag: DiagnosticBag,
): ResolvedRunTypeInternal | undefined {
  const existing = resolved.get(id);
  if (existing !== undefined) {
    return existing;
  }
  const cycleIndex = visiting.indexOf(id);
  if (cycleIndex >= 0) {
    bag.error(
      "configuration.run_type_cycle",
      "/run_types",
      `run type inheritance cycle: ${[...visiting.slice(cycleIndex), id].join(" -> ")}`,
    );
    return undefined;
  }
  const source = sources.get(id);
  if (source === undefined) {
    bag.error(
      "configuration.missing_run_type",
      pointer("/run_types", id),
      "run type source is missing",
    );
    return undefined;
  }
  visiting.push(id);
  const rootPath = fileRoot(source.path);
  const parentId =
    typeof source.document.extends === "string" ? source.document.extends : undefined;
  let behavior: MutableConfigurationObject;
  let ancestry: string[];
  let description: string | undefined;
  if (parentId !== undefined) {
    if (!sources.has(parentId)) {
      bag.error(
        "configuration.missing_run_type_parent",
        pointer(rootPath, "extends"),
        "derived run type parent is not present in the project catalog",
      );
      visiting.pop();
      return undefined;
    }
    const parent = resolveRunType(parentId, sources, resolved, visiting, bag);
    if (parent === undefined) {
      visiting.pop();
      return undefined;
    }
    behavior = cloneObject(extractBehavior(parent.document));
    ancestry = [...parent.ancestry, parent.id];
    description =
      typeof source.document.description === "string"
        ? source.document.description
        : typeof parent.document.description === "string"
          ? parent.document.description
          : undefined;
    const overrides = Array.isArray(source.document.overrides) ? source.document.overrides : [];
    for (const [index, override] of overrides.entries()) {
      applyRunTypeOverride(behavior, override, pointer(pointer(rootPath, "overrides"), index), bag);
    }
  } else {
    behavior = cloneObject(extractBehavior(source.document));
    ancestry = [];
    description =
      typeof source.document.description === "string" ? source.document.description : undefined;
  }
  validateRunBehavior(behavior, rootPath, bag);
  if (bag.hasErrors()) {
    visiting.pop();
    return undefined;
  }
  const document: MutableConfigurationObject = Object.create(null) as MutableConfigurationObject;
  document.schema_version = PROFILE_CONFIGURATION_SCHEMA_VERSION;
  document.id = id;
  document.title = source.document.title ?? id;
  if (description !== undefined) {
    document.description = description;
  }
  for (const field of RUN_BEHAVIOR_FIELDS) {
    if (behavior[field] !== undefined) {
      document[field] = cloneValue(behavior[field]);
    }
  }
  const hashMaterial = {
    id,
    path: source.path,
    ...(parentId === undefined ? {} : { extends: parentId }),
    ancestry,
    document,
  };
  const result: ResolvedRunTypeInternal = {
    id,
    path: source.path,
    ...(parentId === undefined ? {} : { extends: parentId }),
    ancestry,
    source: source.document,
    document,
    sha256: canonicalHash(hashMaterial),
  };
  visiting.pop();
  resolved.set(id, result);
  return result;
}

function validateOverrideShape(
  value: MutableConfigurationValue,
  path: string,
  bag: DiagnosticBag,
): MutableConfigurationObject | undefined {
  const override = exactRecord(value, path, ["op", "path", "value"], bag);
  const operation = requiredString(override, "op", path, bag);
  const pointerValue = requiredString(override, "path", path, bag);
  if (operation !== undefined && !["merge", "replace", "remove"].includes(operation)) {
    bag.error(
      "configuration.override_operation",
      pointer(path, "op"),
      "run type override operation is not supported",
    );
  }
  if (operation === "remove" && override.value !== undefined) {
    bag.error(
      "configuration.override_value",
      pointer(path, "value"),
      "remove override must not include a value",
    );
  }
  if ((operation === "merge" || operation === "replace") && override.value === undefined) {
    bag.error(
      "configuration.override_value",
      pointer(path, "value"),
      "override operation requires a value",
    );
  }
  if (pointerValue !== undefined) {
    const decoded = decodeJsonPointer(pointerValue);
    if (!decoded.ok) {
      bag.error("configuration.override_path", pointer(path, "path"), decoded.message);
    } else if (!RUN_OVERRIDE_ROOTS.has(decoded.segments[0] ?? "")) {
      bag.error(
        "configuration.override_path",
        pointer(path, "path"),
        "override pointer root is not a run type behavior field",
      );
    }
  }
  return override;
}

function applyRunTypeOverride(
  root: MutableConfigurationObject,
  value: MutableConfigurationValue,
  path: string,
  bag: DiagnosticBag,
): void {
  const override = validateOverrideShape(value, path, bag);
  if (override === undefined) {
    return;
  }
  const operation = typeof override.op === "string" ? override.op : undefined;
  const pathValue = typeof override.path === "string" ? override.path : undefined;
  if (operation === undefined || pathValue === undefined) {
    return;
  }
  const decoded = decodeJsonPointer(pathValue);
  if (!decoded.ok || !RUN_OVERRIDE_ROOTS.has(decoded.segments[0] ?? "")) {
    return;
  }
  const final = decoded.segments.at(-1);
  if (final === undefined) {
    return;
  }
  let parent: MutableConfigurationObject = root;
  for (const segment of decoded.segments.slice(0, -1)) {
    const child = parent[segment];
    if (!isMutableRecord(child)) {
      bag.error(
        "configuration.override_target",
        pointer(path, "path"),
        "override pointer traverses a missing or non-object value",
      );
      return;
    }
    parent = child;
  }
  if (!Object.hasOwn(parent, final)) {
    bag.error(
      "configuration.override_target",
      pointer(path, "path"),
      "override target does not exist",
    );
    return;
  }
  if (operation === "remove") {
    delete parent[final];
    return;
  }
  if (override.value === undefined) {
    return;
  }
  if (operation === "replace") {
    parent[final] = cloneValue(override.value);
    return;
  }
  if (operation === "merge") {
    const target = parent[final];
    if (!isMutableRecord(target) || !isMutableRecord(override.value)) {
      bag.error(
        "configuration.override_merge",
        pointer(path, "value"),
        "merge override requires object target and value",
      );
      return;
    }
    recursiveObjectMerge(target, override.value);
  }
}

function decodeJsonPointer(
  value: string,
): { ok: true; segments: string[] } | { ok: false; message: string } {
  if (!value.startsWith("/") || value.length < 2) {
    return { ok: false, message: "override path must be a nonempty JSON Pointer beginning with /" };
  }
  const segments: string[] = [];
  for (const raw of value.slice(1).split("/")) {
    let decoded = "";
    for (let index = 0; index < raw.length; index += 1) {
      const character = raw[index];
      if (character !== "~") {
        decoded += character;
        continue;
      }
      const escape = raw[index + 1];
      if (escape === "0") {
        decoded += "~";
      } else if (escape === "1") {
        decoded += "/";
      } else {
        return { ok: false, message: "override path contains an invalid JSON Pointer escape" };
      }
      index += 1;
    }
    if (decoded.length === 0 || decoded === "-" || /^\d+$/.test(decoded)) {
      return { ok: false, message: "override path contains an empty or array-style segment" };
    }
    segments.push(decoded);
  }
  return { ok: true, segments };
}

function recursiveObjectMerge(
  target: MutableConfigurationObject,
  incoming: MutableConfigurationObject,
): void {
  for (const [key, value] of Object.entries(incoming)) {
    const existing = target[key];
    if (isMutableRecord(existing) && isMutableRecord(value)) {
      recursiveObjectMerge(existing, value);
    } else {
      target[key] = cloneValue(value);
    }
  }
}

function extractBehavior(document: MutableConfigurationObject): MutableConfigurationObject {
  const behavior: MutableConfigurationObject = Object.create(null) as MutableConfigurationObject;
  for (const field of RUN_BEHAVIOR_FIELDS) {
    if (document[field] !== undefined) {
      behavior[field] = document[field];
    }
  }
  return behavior;
}

function validateRunBehavior(
  behavior: MutableConfigurationObject,
  rootPath: string,
  bag: DiagnosticBag,
): void {
  for (const field of ["profile", "intake", "pipeline", "questions", "git", "run_card"] as const) {
    if (behavior[field] === undefined) {
      bag.error(
        "configuration.missing_run_behavior",
        pointer(rootPath, field),
        "base run type is missing a required behavior field",
      );
    }
  }

  const profile =
    behavior.profile === undefined
      ? undefined
      : exactRecord(behavior.profile, pointer(rootPath, "profile"), ["source"], bag);
  if (profile !== undefined) {
    const source = requiredString(profile, "source", pointer(rootPath, "profile"), bag);
    if (source !== undefined && normalizeProfileReference(source) === undefined) {
      bag.error(
        "configuration.profile_source",
        `${rootPath}/profile/source`,
        "run type profile source must resolve to the authenticated profile.yaml",
      );
    }
  }

  const intake =
    behavior.intake === undefined
      ? undefined
      : exactRecord(
          behavior.intake,
          pointer(rootPath, "intake"),
          ["fields", "order", "objective_field"],
          bag,
        );
  if (intake !== undefined) {
    const fields = requiredRecord(intake, "fields", pointer(rootPath, "intake"), bag);
    const order = stringArray(intake.order, `${rootPath}/intake/order`, bag);
    if (fields !== undefined) {
      for (const [id, value] of Object.entries(fields)) {
        if (!isIdentifier(id)) {
          bag.error(
            "configuration.intake_field_id",
            pointer(`${rootPath}/intake/fields`, id),
            "intake field id is not valid",
          );
        }
        const field = exactRecord(
          value,
          pointer(`${rootPath}/intake/fields`, id),
          ["label", "description", "type", "required", "default", "options"],
          bag,
        );
        requiredString(field, "label", pointer(`${rootPath}/intake/fields`, id), bag);
        requiredString(field, "type", pointer(`${rootPath}/intake/fields`, id), bag);
        if (field.description !== undefined) {
          optionalString(field, "description", pointer(`${rootPath}/intake/fields`, id), bag);
        }
        if (field.required !== undefined && typeof field.required !== "boolean") {
          bag.error(
            "configuration.field_type",
            `${pointer(`${rootPath}/intake/fields`, id)}/required`,
            "intake required flag must be boolean",
          );
        }
        if (field.options !== undefined) {
          expectArray(field.options, `${pointer(`${rootPath}/intake/fields`, id)}/options`, bag);
        }
      }
      if (order !== undefined) {
        const seen = new Set<string>();
        for (const [index, id] of order.entries()) {
          if (seen.has(id)) {
            bag.error(
              "configuration.duplicate_intake_order",
              pointer(`${rootPath}/intake/order`, index),
              "intake order contains a duplicate field",
            );
          }
          seen.add(id);
          if (!Object.hasOwn(fields, id)) {
            bag.error(
              "configuration.unknown_intake_field",
              pointer(`${rootPath}/intake/order`, index),
              "intake order references an unknown field",
            );
          }
        }
        for (const id of Object.keys(fields)) {
          if (!seen.has(id)) {
            bag.error(
              "configuration.missing_intake_order",
              pointer(`${rootPath}/intake/fields`, id),
              "intake field is absent from presentation order",
            );
          }
        }
      }
    }
  }

  validateRunPipeline(behavior.pipeline, rootPath, bag);
  validateSimpleRunRecords(behavior, rootPath, bag);
}

function validateRunPipeline(
  value: MutableConfigurationValue | undefined,
  rootPath: string,
  bag: DiagnosticBag,
): void {
  if (value === undefined) {
    return;
  }
  const pipelinePath = pointer(rootPath, "pipeline");
  const pipeline = exactRecord(value, pipelinePath, ["stages", "order"], bag);
  const stages = requiredRecord(pipeline, "stages", pipelinePath, bag);
  const order = stringArray(pipeline.order, pointer(pipelinePath, "order"), bag);
  if (stages === undefined || order === undefined) {
    return;
  }
  const seen = new Set<string>();
  for (const [index, id] of order.entries()) {
    if (seen.has(id)) {
      bag.error(
        "configuration.duplicate_stage",
        pointer(pointer(pipelinePath, "order"), index),
        "pipeline order contains a duplicate stage",
      );
    }
    seen.add(id);
    if (!Object.hasOwn(stages, id)) {
      bag.error(
        "configuration.unknown_stage",
        pointer(pointer(pipelinePath, "order"), index),
        "pipeline order references an unknown stage",
      );
    }
  }
  for (const [id, value] of Object.entries(stages)) {
    const stagePath = pointer(pointer(pipelinePath, "stages"), id);
    if (!isIdentifier(id)) {
      bag.error("configuration.stage_id", stagePath, "pipeline stage id is not valid");
    }
    const stage = exactRecord(value, stagePath, ["kind", "title", "config"], bag);
    requiredString(stage, "kind", stagePath, bag);
    requiredString(stage, "title", stagePath, bag);
    if (stage.config !== undefined) {
      expectRecord(stage.config, pointer(stagePath, "config"), bag);
    }
    if (!seen.has(id)) {
      bag.error(
        "configuration.unordered_stage",
        stagePath,
        "pipeline stage is absent from pipeline order",
      );
    }
  }
}

function validateSimpleRunRecords(
  behavior: MutableConfigurationObject,
  rootPath: string,
  bag: DiagnosticBag,
): void {
  if (behavior.questions !== undefined) {
    exactRecord(behavior.questions, `${rootPath}/questions`, ["policy", "default_scope"], bag);
  }
  if (behavior.git !== undefined) {
    exactRecord(
      behavior.git,
      `${rootPath}/git`,
      ["branch_template", "ticket_branch_template"],
      bag,
    );
  }
  if (behavior.run_card !== undefined) {
    const runCard = exactRecord(behavior.run_card, `${rootPath}/run_card`, ["sections"], bag);
    stringArray(runCard.sections, `${rootPath}/run_card/sections`, bag);
  }
  if (behavior.instructions !== undefined) {
    const instructions = exactRecord(
      behavior.instructions,
      `${rootPath}/instructions`,
      ["planning"],
      bag,
    );
    if (instructions.planning !== undefined) {
      optionalString(instructions, "planning", `${rootPath}/instructions`, bag);
    }
  }
  if (behavior.planning !== undefined) {
    exactRecord(
      behavior.planning,
      `${rootPath}/planning`,
      ["max_repository_tool_calls", "token_budget"],
      bag,
    );
  }
  if (behavior.promotion !== undefined) {
    const promotion = exactRecord(
      behavior.promotion,
      `${rootPath}/promotion`,
      ["conflict_operation"],
      bag,
    );
    requiredString(promotion, "conflict_operation", `${rootPath}/promotion`, bag);
  }
  if (behavior.working_spec !== undefined) {
    const workingSpec = exactRecord(
      behavior.working_spec,
      `${rootPath}/working_spec`,
      ["owner"],
      bag,
    );
    requiredIdentifier(workingSpec, "owner", `${rootPath}/working_spec`, bag);
  }
  if (behavior.orchestration !== undefined) {
    exactRecord(
      behavior.orchestration,
      `${rootPath}/orchestration`,
      [
        "auto_start",
        "max_parallel",
        "compile_action",
        "lead_action",
        "lead_triggers",
        "report_action",
      ],
      bag,
    );
  }
  if (behavior.agents !== undefined) {
    const agents = exactRecord(behavior.agents, `${rootPath}/agents`, ["roles", "personas"], bag);
    const roles = requiredRecord(agents, "roles", `${rootPath}/agents`, bag);
    if (roles !== undefined) {
      for (const [roleId, value] of Object.entries(roles)) {
        const rolePath = pointer(`${rootPath}/agents/roles`, roleId);
        if (!isIdentifier(roleId)) {
          bag.error("configuration.agent_role", rolePath, "agent role id is not valid");
        }
        const role = exactRecord(value, rolePath, ["provider", "model", "thinking_level"], bag);
        requiredString(role, "model", rolePath, bag);
        requiredThinkingLevel(role, "thinking_level", rolePath, bag);
        if (role.provider !== undefined) {
          optionalString(role, "provider", rolePath, bag);
        }
      }
    }
    if (agents.personas !== undefined) {
      expectRecord(agents.personas, `${rootPath}/agents/personas`, bag);
    }
  }
}

function normalizeProfileReference(source: string): string | undefined {
  if (source === "profile.yaml" || source === ".koni/profile.yaml") {
    return "profile.yaml";
  }
  return undefined;
}

function validateCrossReferences(
  profile: MutableConfigurationObject,
  runTypes: ReadonlyMap<string, ResolvedRunTypeInternal>,
  state: RegistryState,
  bag: DiagnosticBag,
): void {
  const registries = state.records;
  const operationAliases = new Map<string, string[]>();
  for (const [id, operation] of registries.operations) {
    const path = locationOf(state, operation, pointer("/registries/operations", id));
    const publicName = requiredString(operation, "operation", path, bag);
    if (publicName !== undefined) {
      const ids = operationAliases.get(publicName) ?? [];
      ids.push(id);
      operationAliases.set(publicName, ids);
    }
  }
  const actionAliases = new Map<string, string>();
  for (const [id, action] of registries.actions) {
    actionAliases.set(id, id);
    const path = locationOf(state, action, pointer("/registries/actions", id));
    if (action.aliases === undefined) {
      continue;
    }
    const aliases = stringArray(action.aliases, pointer(path, "aliases"), bag);
    for (const alias of aliases ?? []) {
      const existing = actionAliases.get(alias);
      if (existing !== undefined && existing !== id) {
        bag.error(
          "configuration.duplicate_action_alias",
          pointer(path, "aliases"),
          "action alias is ambiguous",
        );
      } else {
        actionAliases.set(alias, id);
      }
    }
  }

  const initialization =
    profile.initialization === undefined
      ? undefined
      : expectRecord(profile.initialization, "/profile/initialization", bag);
  if (initialization !== undefined) {
    validateReferenceField(
      initialization,
      "root_node_type",
      "/profile/initialization",
      registries.node_types,
      "node type",
      bag,
    );
    validateReferenceField(
      initialization,
      "planning_seed_operation",
      "/profile/initialization",
      registries.operations,
      "operation",
      bag,
    );
  }

  for (const edge of state.edgeTypes) {
    const path = locationOf(state, edge, "/edge_types");
    validateReferenceField(edge, "source", path, registries.node_types, "node type", bag);
    validateReferenceArray(
      edge.targets,
      pointer(path, "targets"),
      registries.node_types,
      "node type",
      bag,
    );
  }
  for (const [id, query] of registries.queries) {
    const path = locationOf(state, query, pointer("/registries/queries", id));
    if (query.node_types !== undefined) {
      validateReferenceArray(
        query.node_types,
        pointer(path, "node_types"),
        registries.node_types,
        "node type",
        bag,
      );
    }
  }
  for (const [id, policy] of registries.gate_policies) {
    const path = locationOf(state, policy, pointer("/registries/gate_policies", id));
    for (const field of ["gate_node_types", "candidate_node_types"] as const) {
      if (policy[field] !== undefined) {
        validateReferenceArray(
          policy[field],
          pointer(path, field),
          registries.node_types,
          "node type",
          bag,
        );
      }
    }
    for (const field of ["gate_subjects", "candidate_pool"] as const) {
      if (policy[field] !== undefined) {
        validateReferenceValue(
          policy[field],
          pointer(path, field),
          registries.queries,
          "query",
          bag,
        );
      }
    }
  }

  for (const [id, operation] of registries.operations) {
    const path = locationOf(state, operation, pointer("/registries/operations", id));
    for (const field of [
      "target_types",
      "allowed_new_node_types",
      "allowed_existing_node_types",
    ] as const) {
      if (operation[field] !== undefined) {
        validateReferenceArray(
          operation[field],
          pointer(path, field),
          registries.node_types,
          "node type",
          bag,
        );
      }
    }
    if (operation.workflow !== undefined) {
      validateReferenceField(operation, "workflow", path, registries.workflows, "workflow", bag);
    }
    if (operation.checks !== undefined) {
      validateReferenceArray(
        operation.checks,
        pointer(path, "checks"),
        registries.checks,
        "check",
        bag,
      );
    }
  }

  for (const [id, workflow] of registries.workflows) {
    const path = locationOf(state, workflow, pointer("/registries/workflows", id));
    if (workflow.applies_to !== undefined) {
      validateOperationAliasArray(
        workflow.applies_to,
        pointer(path, "applies_to"),
        operationAliases,
        bag,
      );
    }
    validateWorkflowSteps(workflow, path, state, actionAliases, bag);
  }

  for (const [id, rule] of registries.rules) {
    const path = locationOf(state, rule, pointer("/registries/rules", id));
    if (rule.emit === undefined) {
      continue;
    }
    const emit = expectRecord(rule.emit, pointer(path, "emit"), bag);
    if (emit === undefined) {
      continue;
    }
    if (emit.operation !== undefined) {
      validateOperationAlias(
        emit.operation,
        pointer(pointer(path, "emit"), "operation"),
        operationAliases,
        bag,
      );
    }
    if (emit.registry_entry_id !== undefined) {
      validateReferenceValue(
        emit.registry_entry_id,
        pointer(pointer(path, "emit"), "registry_entry_id"),
        registries.operations,
        "operation",
        bag,
      );
    }
    if (emit.workflow !== undefined) {
      validateReferenceValue(
        emit.workflow,
        pointer(pointer(path, "emit"), "workflow"),
        registries.workflows,
        "workflow",
        bag,
      );
    }
  }

  for (const [id, check] of registries.checks) {
    const path = locationOf(state, check, pointer("/registries/checks", id));
    if (check.applies_to !== undefined) {
      validateOperationAliasArray(
        check.applies_to,
        pointer(path, "applies_to"),
        operationAliases,
        bag,
      );
    }
  }

  for (const [id, persona] of registries.personas) {
    const path = locationOf(state, persona, pointer("/registries/personas", id));
    validateReferenceField(persona, "agent", path, registries.agents, "agent", bag);
    const modelRole = requiredIdentifier(persona, "model_role", path, bag);
    if (modelRole !== undefined) {
      for (const runType of runTypes.values()) {
        const roles =
          runType.document.agents === undefined
            ? undefined
            : recordField(runType.document.agents, "roles");
        if (roles === undefined || !Object.hasOwn(roles, modelRole)) {
          bag.error(
            "configuration.missing_model_role",
            pointer(path, "model_role"),
            `persona model role is absent from run type ${runType.id}`,
          );
        }
      }
    }
  }

  for (const runType of runTypes.values()) {
    const workingSpec =
      runType.document.working_spec === undefined
        ? undefined
        : expectRecord(
            runType.document.working_spec,
            pointer(pointer("/run_types", runType.id), "working_spec"),
            bag,
          );
    const owner =
      workingSpec === undefined
        ? undefined
        : requiredIdentifier(
            workingSpec,
            "owner",
            pointer(pointer("/run_types", runType.id), "working_spec"),
            bag,
          );
    if (owner !== undefined && !registries.personas.has(owner)) {
      bag.error(
        "configuration.working_spec_owner",
        pointer(pointer(pointer("/run_types", runType.id), "working_spec"), "owner"),
        `working-spec owner persona ${owner} is not configured`,
      );
    }
    validateRunTypeCrossReferences(runType, state, operationAliases, actionAliases, bag);
  }
}

function validateWorkflowSteps(
  workflow: MutableConfigurationObject,
  path: string,
  state: RegistryState,
  actionAliases: ReadonlyMap<string, string>,
  bag: DiagnosticBag,
): void {
  const steps = expectArray(workflow.steps, pointer(path, "steps"), bag);
  if (steps === undefined) {
    return;
  }
  const stepRecords = new Map<string, { value: MutableConfigurationObject; path: string }>();
  for (const [index, value] of steps.entries()) {
    const stepPath = pointer(pointer(path, "steps"), index);
    const step = expectRecord(value, stepPath, bag);
    if (step === undefined) {
      continue;
    }
    const id = requiredIdentifier(step, "id", stepPath, bag);
    validateReferenceField(step, "persona", stepPath, state.records.personas, "persona", bag);
    if (step.validation_action !== undefined) {
      validateActionReference(
        step.validation_action,
        pointer(stepPath, "validation_action"),
        actionAliases,
        bag,
      );
    }
    if (step.checks !== undefined) {
      validateReferenceArray(
        step.checks,
        pointer(stepPath, "checks"),
        state.records.checks,
        "check",
        bag,
      );
    }
    if (id !== undefined) {
      if (stepRecords.has(id)) {
        bag.error(
          "configuration.duplicate_workflow_step",
          pointer(stepPath, "id"),
          "workflow step id is duplicated",
        );
      } else {
        stepRecords.set(id, { value: step, path: stepPath });
      }
    }
  }
  for (const { value, path: stepPath } of stepRecords.values()) {
    if (value.depends_on === undefined) {
      continue;
    }
    const dependencies = stringArray(value.depends_on, pointer(stepPath, "depends_on"), bag);
    if (dependencies === undefined) {
      continue;
    }
    for (const [index, dependency] of dependencies.entries()) {
      if (!stepRecords.has(dependency)) {
        bag.error(
          "configuration.unknown_workflow_step",
          pointer(pointer(stepPath, "depends_on"), index),
          "workflow dependency references an unknown step",
        );
      }
    }
  }
  validateDependencyCycle(stepRecords, bag);
}

function validateDependencyCycle(
  steps: ReadonlyMap<string, { value: MutableConfigurationObject; path: string }>,
  bag: DiagnosticBag,
): void {
  const complete = new Set<string>();
  const visiting: string[] = [];
  const visit = (id: string): void => {
    if (complete.has(id)) {
      return;
    }
    const cycleStart = visiting.indexOf(id);
    if (cycleStart >= 0) {
      const step = steps.get(id);
      bag.error(
        "configuration.workflow_cycle",
        step?.path ?? "/workflows",
        `workflow dependency cycle: ${[...visiting.slice(cycleStart), id].join(" -> ")}`,
      );
      return;
    }
    const step = steps.get(id);
    if (step === undefined) {
      return;
    }
    visiting.push(id);
    const dependencies = Array.isArray(step.value.depends_on)
      ? step.value.depends_on.filter((value): value is string => typeof value === "string")
      : [];
    for (const dependency of dependencies) {
      visit(dependency);
    }
    visiting.pop();
    complete.add(id);
  };
  for (const id of steps.keys()) {
    visit(id);
  }
}

function validateRunTypeCrossReferences(
  runType: ResolvedRunTypeInternal,
  state: RegistryState,
  operationAliases: ReadonlyMap<string, readonly string[]>,
  actionAliases: ReadonlyMap<string, string>,
  bag: DiagnosticBag,
): void {
  const rootPath = pointer("/run_types", runType.id);
  const pipeline = recordValue(runType.document.pipeline);
  const stages = pipeline === undefined ? undefined : recordValue(pipeline.stages);
  if (stages !== undefined) {
    for (const [id, value] of Object.entries(stages)) {
      const stage = recordValue(value);
      if (stage === undefined) {
        continue;
      }
      const stagePath = pointer(`${rootPath}/pipeline/stages`, id);
      const kind = typeof stage.kind === "string" ? stage.kind : undefined;
      const config = recordValue(stage.config);
      if (kind === "planning" || kind === "agent_dialog" || kind === "ai") {
        const persona = config?.persona;
        validateReferenceValue(
          persona,
          `${stagePath}/config/persona`,
          state.records.personas,
          "persona",
          bag,
        );
      } else if (kind === "agent_review") {
        const persona = config?.persona ?? "reviewer";
        validateReferenceValue(
          persona,
          `${stagePath}/config/persona`,
          state.records.personas,
          "persona",
          bag,
        );
      }
      if (kind === "action" && config !== undefined) {
        const compilerOwned = config.compiler_owned === true;
        if (!compilerOwned && config.action !== undefined) {
          validateReferenceValue(
            config.action,
            `${stagePath}/config/action`,
            state.records.actions,
            "action",
            bag,
          );
        }
      }
    }
  }
  const orchestration = recordValue(runType.document.orchestration);
  if (orchestration !== undefined) {
    for (const field of ["compile_action", "lead_action", "report_action"] as const) {
      validateActionReference(
        orchestration[field],
        `${rootPath}/orchestration/${field}`,
        actionAliases,
        bag,
      );
    }
  }
  const promotion = recordValue(runType.document.promotion);
  if (promotion?.conflict_operation !== undefined) {
    const operation = promotion.conflict_operation;
    if (typeof operation !== "string") {
      bag.error(
        "configuration.reference_type",
        `${rootPath}/promotion/conflict_operation`,
        "operation reference must be a string",
      );
    } else {
      const matches = operationAliases.get(operation) ?? [];
      if (matches.length === 0) {
        bag.error(
          "configuration.dangling_reference",
          `${rootPath}/promotion/conflict_operation`,
          "promotion conflict operation is not defined",
        );
      } else if (matches.length > 1) {
        bag.error(
          "configuration.ambiguous_reference",
          `${rootPath}/promotion/conflict_operation`,
          "promotion conflict operation is ambiguous",
        );
      }
    }
  }
}

function validateActionReference(
  value: MutableConfigurationValue | undefined,
  path: string,
  aliases: ReadonlyMap<string, string>,
  bag: DiagnosticBag,
): void {
  if (typeof value !== "string") {
    bag.error("configuration.reference_type", path, "action reference must be a string");
  } else if (!aliases.has(value)) {
    bag.error("configuration.dangling_reference", path, "action reference is not defined");
  }
}

function validateReferenceField(
  record: MutableConfigurationObject,
  field: string,
  path: string,
  registry: ReadonlyMap<string, MutableConfigurationObject>,
  label: string,
  bag: DiagnosticBag,
): void {
  validateReferenceValue(record[field], pointer(path, field), registry, label, bag);
}

function validateReferenceValue(
  value: MutableConfigurationValue | undefined,
  path: string,
  registry: ReadonlyMap<string, MutableConfigurationObject>,
  label: string,
  bag: DiagnosticBag,
): void {
  if (typeof value !== "string") {
    bag.error("configuration.reference_type", path, `${label} reference must be a string`);
  } else if (!registry.has(value)) {
    bag.error("configuration.dangling_reference", path, `${label} reference is not defined`);
  }
}

function validateReferenceArray(
  value: MutableConfigurationValue | undefined,
  path: string,
  registry: ReadonlyMap<string, MutableConfigurationObject>,
  label: string,
  bag: DiagnosticBag,
): void {
  const references = stringArray(value, path, bag);
  if (references === undefined) {
    return;
  }
  for (const [index, reference] of references.entries()) {
    if (!registry.has(reference)) {
      bag.error(
        "configuration.dangling_reference",
        pointer(path, index),
        `${label} reference is not defined`,
      );
    }
  }
}

function validateOperationAliasArray(
  value: MutableConfigurationValue | undefined,
  path: string,
  aliases: ReadonlyMap<string, readonly string[]>,
  bag: DiagnosticBag,
): void {
  const references = stringArray(value, path, bag);
  if (references === undefined) {
    return;
  }
  references.forEach((reference, index) =>
    validateOperationAlias(reference, pointer(path, index), aliases, bag),
  );
}

function validateOperationAlias(
  value: MutableConfigurationValue | undefined,
  path: string,
  aliases: ReadonlyMap<string, readonly string[]>,
  bag: DiagnosticBag,
): void {
  if (typeof value !== "string") {
    bag.error("configuration.reference_type", path, "operation alias must be a string");
  } else if (!aliases.has(value)) {
    bag.error("configuration.dangling_reference", path, "operation alias is not defined");
  }
}

function createRegistryState(): RegistryState {
  const records = Object.create(null) as Record<
    ConfigurationRegistryKind,
    Map<string, MutableConfigurationObject>
  >;
  for (const kind of CONFIGURATION_REGISTRY_KINDS) {
    records[kind] = new Map();
  }
  return {
    records,
    edgeTypes: [],
    edgeKeys: new Set(),
    locations: new Map(),
  };
}

function materializeRegistries(
  registries: Record<ConfigurationRegistryKind, Map<string, MutableConfigurationObject>>,
): CompiledConfigurationMaterial["registries"] {
  const result = Object.create(null) as Record<
    ConfigurationRegistryKind,
    Record<string, ConfigurationObject>
  >;
  for (const kind of CONFIGURATION_REGISTRY_KINDS) {
    const registry: Record<string, ConfigurationObject> = Object.create(null) as Record<
      string,
      ConfigurationObject
    >;
    for (const id of [...registries[kind].keys()].sort(compareUtf8)) {
      const value = registries[kind].get(id);
      if (value !== undefined) {
        registry[id] = value;
      }
    }
    result[kind] = registry;
  }
  return result;
}

function createCategoryRecord<Value>(factory: () => Value): Record<ProfileImportCategory, Value> {
  const result = Object.create(null) as Record<ProfileImportCategory, Value>;
  for (const category of PROFILE_IMPORT_CATEGORIES) {
    result[category] = factory();
  }
  return result;
}

function locationOf(
  state: RegistryState,
  value: MutableConfigurationObject,
  fallback: string,
): string {
  return state.locations.get(value) ?? fallback;
}

function exactRecord(
  value: MutableConfigurationValue | undefined,
  path: string,
  allowedFields: readonly string[],
  bag: DiagnosticBag,
): MutableConfigurationObject {
  const record = expectRecord(value, path, bag);
  if (record === undefined) {
    return Object.create(null) as MutableConfigurationObject;
  }
  const allowed = new Set(allowedFields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      bag.error(
        "configuration.unknown_field",
        pointer(path, key),
        "configuration mapping contains an unknown field",
      );
    }
  }
  return record;
}

function requiredExactRecord(
  parent: MutableConfigurationObject,
  field: string,
  parentPath: string,
  allowedFields: readonly string[],
  bag: DiagnosticBag,
): MutableConfigurationObject | undefined {
  if (parent[field] === undefined) {
    bag.error(
      "configuration.required_field",
      pointer(parentPath, field),
      "required configuration field is missing",
    );
    return undefined;
  }
  const record = exactRecord(parent[field], pointer(parentPath, field), allowedFields, bag);
  return isMutableRecord(parent[field]) ? record : undefined;
}

function requiredRecord(
  parent: MutableConfigurationObject,
  field: string,
  parentPath: string,
  bag: DiagnosticBag,
): MutableConfigurationObject | undefined {
  if (parent[field] === undefined) {
    bag.error(
      "configuration.required_field",
      pointer(parentPath, field),
      "required configuration field is missing",
    );
    return undefined;
  }
  return expectRecord(parent[field], pointer(parentPath, field), bag);
}

function expectRecord(
  value: MutableConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): MutableConfigurationObject | undefined {
  if (!isMutableRecord(value)) {
    bag.error("configuration.mapping", path, "configuration value must be a mapping");
    return undefined;
  }
  return value;
}

function recordValue(
  value: MutableConfigurationValue | undefined,
): MutableConfigurationObject | undefined {
  return isMutableRecord(value) ? value : undefined;
}

function recordField(
  value: MutableConfigurationValue | undefined,
  field: string,
): MutableConfigurationObject | undefined {
  return isMutableRecord(value) ? recordValue(value[field]) : undefined;
}

function expectArray(
  value: MutableConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): MutableConfigurationValue[] | undefined {
  if (!Array.isArray(value)) {
    bag.error("configuration.array", path, "configuration value must be an array");
    return undefined;
  }
  return value;
}

function stringArray(
  value: MutableConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): string[] | undefined {
  const values = expectArray(value, path, bag);
  if (values === undefined) {
    return undefined;
  }
  const strings: string[] = [];
  for (const [index, item] of values.entries()) {
    if (typeof item !== "string" || item.trim().length === 0) {
      bag.error(
        "configuration.string",
        pointer(path, index),
        "configuration array item must be a nonempty string",
      );
    } else {
      strings.push(item);
    }
  }
  return strings;
}

function requiredString(
  parent: MutableConfigurationObject,
  field: string,
  parentPath: string,
  bag: DiagnosticBag,
): string | undefined {
  const value = parent[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    bag.error(
      "configuration.required_string",
      pointer(parentPath, field),
      "required configuration field must be a nonempty string",
    );
    return undefined;
  }
  return value;
}

/**
 * Reasoning is a profile-wide invariant: a dormant preset must not be allowed to
 * make an otherwise selected run fail only when the full run program compiles.
 */
function requiredThinkingLevel(
  parent: MutableConfigurationObject,
  field: string,
  parentPath: string,
  bag: DiagnosticBag,
): string | undefined {
  const value = requiredString(parent, field, parentPath, bag);
  if (value === undefined) return undefined;
  const fieldPath = pointer(parentPath, field);
  if (value === "ultra") {
    bag.error(
      "configuration.legacy_thinking_level",
      fieldPath,
      "legacy ultra reasoning must be migrated to Pi max",
    );
  } else if (!PI_THINKING_LEVELS.has(value)) {
    bag.error("configuration.thinking_level", fieldPath, `unsupported Pi thinking level ${value}`);
  }
  return value;
}

function optionalString(
  parent: MutableConfigurationObject,
  field: string,
  parentPath: string,
  bag: DiagnosticBag,
): string | undefined {
  const value = parent[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    bag.error(
      "configuration.string",
      pointer(parentPath, field),
      "configuration field must be a nonempty string",
    );
    return undefined;
  }
  return value;
}

function requiredIdentifier(
  parent: MutableConfigurationObject,
  field: string,
  parentPath: string,
  bag: DiagnosticBag,
): string | undefined {
  const value = requiredString(parent, field, parentPath, bag);
  if (value !== undefined && !isIdentifier(value)) {
    bag.error(
      "configuration.identifier",
      pointer(parentPath, field),
      "configuration identifier is not valid",
    );
    return undefined;
  }
  return value;
}

function optionalIdentifier(
  parent: MutableConfigurationObject,
  field: string,
  parentPath: string,
  bag: DiagnosticBag,
): string | undefined {
  const value = optionalString(parent, field, parentPath, bag);
  if (value !== undefined && !isIdentifier(value)) {
    bag.error(
      "configuration.identifier",
      pointer(parentPath, field),
      "configuration identifier is not valid",
    );
    return undefined;
  }
  return value;
}

function isIdentifier(value: string): boolean {
  return value.length <= 256 && value.trim() === value && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function isMutableRecord(value: unknown): value is MutableConfigurationObject {
  return isPlainRecord(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function toMutableObject(value: Record<string, unknown>): MutableConfigurationObject {
  const normalized = cloneUnknown(value);
  if (!isMutableRecord(normalized)) {
    throw new TypeError("strict YAML object normalization produced a non-object");
  }
  return normalized;
}

function cloneUnknown(value: unknown): MutableConfigurationValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneUnknown);
  }
  if (isPlainRecord(value)) {
    const result: MutableConfigurationObject = Object.create(null) as MutableConfigurationObject;
    for (const [key, item] of Object.entries(value)) {
      result[key] = cloneUnknown(item);
    }
    return result;
  }
  throw new TypeError("strict YAML normalization contained an unsupported value");
}

function cloneValue(value: MutableConfigurationValue): MutableConfigurationValue {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (isMutableRecord(value)) {
    return cloneObject(value);
  }
  return value;
}

function cloneObject(value: MutableConfigurationObject): MutableConfigurationObject {
  const result: MutableConfigurationObject = Object.create(null) as MutableConfigurationObject;
  for (const [key, item] of Object.entries(value)) {
    result[key] = cloneValue(item);
  }
  return result;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => deepFreeze(item));
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
  }
  Object.freeze(value);
  return value;
}
