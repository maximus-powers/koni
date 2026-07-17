import type { JsonValue } from "./protocol.js";
import {
  CONFIG_CATALOG_PROTOCOL,
  CONFIG_SNAPSHOT_PROTOCOL,
  THINKING_LEVELS,
  type ConfigCatalog,
  type ConfigFieldDefinition,
  type ConfigResourceDefinition,
  type ConfigSectionDefinition,
  type ConfigSnapshot,
} from "../control-center/protocol.js";
import {
  catalogProjectAuthoredConfig,
  readProjectAuthoredConfigDocument,
  readProjectConfigMutationMarker,
  updateProjectAuthoredConfigDocuments,
  type ProjectAuthoredConfigDocument,
  type ProjectConfigCatalogEntry,
  type ProjectConfigSemanticDomain,
} from "../profile/config-edit.js";
import { rawSha256, type Sha256Digest } from "../shared/canonical.js";

const CONFIG_CAS_PROTOCOL = "koni.config-cas.v1" as const;

interface ConfigFieldBinding {
  key: string;
  path: string;
  pointer: Array<string | number>;
  definition: ConfigFieldDefinition;
  value: JsonValue;
}

interface ConfigSurfaceProjection {
  catalog: ConfigCatalog;
  snapshot: ConfigSnapshot;
  documents: Map<string, ProjectAuthoredConfigDocument>;
  bindings: Map<string, ConfigFieldBinding>;
  resources: Map<string, ConfigResourceBinding>;
  templates: Map<string, ConfigTemplateBinding>;
  sections: Map<string, ProjectConfigSemanticDomain>;
}

interface ConfigResourceBinding {
  id: string;
  path: string;
  pointer: Array<string | number>;
  parentId?: string;
  depth: number;
  title: string;
  semanticDomain: ProjectConfigSemanticDomain;
  kind: "document" | "array_item" | "nested";
  value: Record<string, unknown>;
}

interface ConfigTemplateBinding {
  id: string;
  sectionId: string;
  resourceId: string;
  parentResourceId?: string;
}

interface ConfigCas {
  protocol: typeof CONFIG_CAS_PROTOCOL;
  lifecycleGeneration: number;
  configurationSha256: Sha256Digest;
  documents: Record<string, Sha256Digest>;
}

const SECTION_ORDER: readonly ProjectConfigSemanticDomain[] = [
  "run-type",
  "agent",
  "personas",
  "workflows",
  "graph",
  "rules",
  "operations",
  "checks",
  "actions",
  "reports",
  "resource",
  "project",
  "profile",
  "cockpit",
  "lifecycle",
  "other",
];

const SECTION_COPY: Record<ProjectConfigSemanticDomain, { title: string; description: string }> = {
  "run-type": { title: "Run Types", description: "Complexity, stages, questions, parallelism, and role defaults." },
  agent: { title: "Agents", description: "Agent prompts, provider defaults, reasoning, skills, and capabilities." },
  personas: { title: "Personas", description: "Which agent resources execute each workflow role." },
  workflows: { title: "Ticket Workflows", description: "Ordered ticket steps, reviewers, checks, and rework routes." },
  graph: { title: "Context Graph", description: "Node vocabulary, metadata, statuses, and relationship definitions." },
  rules: { title: "Compiler Rules", description: "Eligibility, validation, derivation, and completion rules." },
  operations: { title: "Ticket Types", description: "Compiler-derived work types, scopes, and output contracts." },
  checks: { title: "Verification", description: "Configured commands, graph checks, evidence, and receipts." },
  actions: { title: "Actions", description: "Compiler and lifecycle actions used by the project workflow." },
  reports: { title: "Reports", description: "Human and model-facing completion report definitions." },
  resource: { title: "Pi Resources", description: "Opt-in skills and packages bound to Koni attempts." },
  project: { title: "Project", description: "Project identity and repository-specific context." },
  profile: { title: "Profile", description: "Profile identity, imports, and shared defaults." },
  cockpit: { title: "Control Center", description: "Project-defined dashboard presentation settings." },
  lifecycle: { title: "Lifecycle", description: "Run lifecycle and state transition configuration." },
  other: { title: "Advanced", description: "Additional structured project resources." },
};

export async function buildConfigSurfaceCatalog(
  projectRoot: string,
  profilePackageRoot: string,
): Promise<ConfigCatalog> {
  return (await projectConfigSurface(projectRoot, profilePackageRoot)).catalog;
}

export async function buildConfigSurfaceSnapshot(
  projectRoot: string,
  profilePackageRoot: string,
): Promise<ConfigSnapshot> {
  return (await projectConfigSurface(projectRoot, profilePackageRoot)).snapshot;
}

export async function publishConfigSurfaceSnapshot(input: {
  projectRoot: string;
  profilePackageRoot: string;
  cas: JsonValue;
  values: Readonly<Record<string, JsonValue>>;
}): Promise<{ snapshot: ConfigSnapshot; changedDocuments: number }> {
  const current = await projectConfigSurface(input.projectRoot, input.profilePackageRoot);
  const cas = parseCas(input.cas);
  const currentCas = parseCas(current.snapshot.cas);
  if (JSON.stringify(cas) !== JSON.stringify(currentCas)) {
    throw new ConfigSurfaceError("config_source_changed", "configuration changed since the editor was opened");
  }
  const expectedKeys = [...current.bindings.keys()].sort();
  const suppliedKeys = Object.keys(input.values).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(suppliedKeys)) {
    throw new ConfigSurfaceError("config_fields_changed", "configuration fields changed since the editor was opened");
  }
  const changed = new Map<string, Record<string, unknown>>();
  for (const key of expectedKeys) {
    const binding = current.bindings.get(key)!;
    const nextValue = normalizeFieldValue(input.values[key], binding.definition);
    if (JSON.stringify(nextValue) === JSON.stringify(binding.value)) continue;
    const source = current.documents.get(binding.path)!;
    const document = changed.get(binding.path) ?? structuredClone(source.document);
    setPointer(document, binding.pointer, nextValue);
    changed.set(binding.path, document);
  }
  if (changed.size === 0) return { snapshot: current.snapshot, changedDocuments: 0 };
  await updateProjectAuthoredConfigDocuments({
    projectRoot: input.projectRoot,
    profilePackageRoot: input.profilePackageRoot,
    documents: [...changed.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, document]) => ({
      path,
      expectedSourceSha256: current.documents.get(path)!.entry.sourceSha256,
      document,
    })),
  });
  return {
    snapshot: await buildConfigSurfaceSnapshot(input.projectRoot, input.profilePackageRoot),
    changedDocuments: changed.size,
  };
}

export interface ConfigSurfaceResourceMutationResult {
  catalog: ConfigCatalog;
  snapshot: ConfigSnapshot;
  changedDocuments: number;
}

export async function createConfigSurfaceResource(input: {
  projectRoot: string;
  profilePackageRoot: string;
  cas: JsonValue;
  sectionId: string;
  templateId: string;
  parentResourceId?: string;
  name: string;
  mutationMarker?: { id: string; requestSha256: Sha256Digest };
}): Promise<ConfigSurfaceResourceMutationResult> {
  const current = await projectConfigSurface(input.projectRoot, input.profilePackageRoot);
  assertCurrentCas(current, input.cas);
  const expectedDomain = current.sections.get(input.sectionId);
  const template = current.templates.get(input.templateId);
  if (expectedDomain === undefined || template === undefined || template.sectionId !== input.sectionId ||
      template.parentResourceId !== input.parentResourceId) {
    throw new ConfigSurfaceError("config_template_changed", "the selected configuration template is no longer available");
  }
  return cloneBoundResource(current, template.resourceId, input.name, input.projectRoot, input.profilePackageRoot, input.mutationMarker);
}

export async function duplicateConfigSurfaceResource(input: {
  projectRoot: string;
  profilePackageRoot: string;
  cas: JsonValue;
  resourceId: string;
  name: string;
  mutationMarker?: { id: string; requestSha256: Sha256Digest };
}): Promise<ConfigSurfaceResourceMutationResult> {
  const current = await projectConfigSurface(input.projectRoot, input.profilePackageRoot);
  assertCurrentCas(current, input.cas);
  const binding = current.resources.get(input.resourceId);
  if (binding === undefined || !isCloneableResource(binding)) {
    throw new ConfigSurfaceError("config_resource_changed", "the selected configuration resource cannot be duplicated");
  }
  return cloneBoundResource(current, input.resourceId, input.name, input.projectRoot, input.profilePackageRoot, input.mutationMarker);
}

export async function deleteConfigSurfaceResource(input: {
  projectRoot: string;
  profilePackageRoot: string;
  cas: JsonValue;
  resourceId: string;
  mutationMarker?: { id: string; requestSha256: Sha256Digest };
}): Promise<ConfigSurfaceResourceMutationResult> {
  const current = await projectConfigSurface(input.projectRoot, input.profilePackageRoot);
  assertCurrentCas(current, input.cas);
  const binding = current.resources.get(input.resourceId);
  if (binding === undefined || !isCloneableResource(binding)) {
    throw new ConfigSurfaceError("config_resource_changed", "the selected configuration resource cannot be deleted");
  }
  if (binding.kind === "document") {
    const source = current.documents.get(binding.path)!;
    const documents = binding.semanticDomain === "run-type"
      ? [runTypeCatalogUpdate(current, binding, undefined)]
      : [];
    await updateProjectAuthoredConfigDocuments({
      projectRoot: input.projectRoot,
      profilePackageRoot: input.profilePackageRoot,
      documents,
      deletes: [{ path: binding.path, expectedSourceSha256: source.entry.sourceSha256 }],
      ...(input.mutationMarker === undefined ? {} : { mutationMarker: input.mutationMarker }),
    });
    return refreshedMutationResult(input.projectRoot, input.profilePackageRoot, documents.length + 1);
  }
  const source = current.documents.get(binding.path)!;
  const document = structuredClone(source.document);
  const parent = pointerValue(document, binding.pointer.slice(0, -1));
  const index = binding.pointer.at(-1);
  if (!Array.isArray(parent) || typeof index !== "number" || !isRecord(parent[index])) {
    throw new ConfigSurfaceError("config_resource_changed", "the selected configuration resource moved");
  }
  parent.splice(index, 1);
  await updateProjectAuthoredConfigDocuments({
    projectRoot: input.projectRoot,
    profilePackageRoot: input.profilePackageRoot,
    documents: [{ path: binding.path, expectedSourceSha256: source.entry.sourceSha256, document }],
    ...(input.mutationMarker === undefined ? {} : { mutationMarker: input.mutationMarker }),
  });
  return refreshedMutationResult(input.projectRoot, input.profilePackageRoot, 1);
}

export async function recoverConfigSurfaceResourceMutation(input: {
  projectRoot: string;
  profilePackageRoot: string;
  mutationMarker: { id: string; requestSha256: Sha256Digest };
}): Promise<ConfigSurfaceResourceMutationResult | undefined> {
  const marker = await readProjectConfigMutationMarker(input.projectRoot, input.mutationMarker.id);
  if (marker === undefined) return undefined;
  if (marker.requestSha256 !== input.mutationMarker.requestSha256) {
    throw new ConfigSurfaceError("config_mutation_replay", "configuration mutation identity was reused with different input");
  }
  return refreshedMutationResult(input.projectRoot, input.profilePackageRoot, 0);
}

export class ConfigSurfaceError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ConfigSurfaceError";
  }
}

async function projectConfigSurface(
  projectRoot: string,
  profilePackageRoot: string,
): Promise<ConfigSurfaceProjection> {
  const sourceCatalog = await catalogProjectAuthoredConfig(projectRoot, profilePackageRoot);
  const editable = sourceCatalog.entries.filter((entry) => entry.guidedEditable);
  const reads = await Promise.all(editable.map((entry) =>
    readProjectAuthoredConfigDocument(projectRoot, profilePackageRoot, entry.path)));
  const documents = new Map(reads.map((document) => [document.entry.path, document]));
  const bindings = new Map<string, ConfigFieldBinding>();
  const resourceBindings = new Map<string, ConfigResourceBinding>();
  const byDomain = new Map<ProjectConfigSemanticDomain, ConfigResourceDefinition[]>();
  for (const source of reads) {
    const resources = projectResources(source, bindings, resourceBindings);
    if (resources.length === 0) continue;
    const current = byDomain.get(source.entry.semanticDomain) ?? [];
    current.push(...resources);
    byDomain.set(source.entry.semanticDomain, current);
  }
  const sectionDomains = new Map<string, ProjectConfigSemanticDomain>();
  const sections: ConfigSectionDefinition[] = SECTION_ORDER.flatMap((domain) => {
    const resources = byDomain.get(domain);
    if (resources === undefined || resources.length === 0) return [];
    const copy = SECTION_COPY[domain];
    const id = opaqueId("section", domain);
    sectionDomains.set(id, domain);
    return [{
      id,
      title: copy.title,
      description: copy.description,
      resources: resources.sort((left, right) => {
        const leftBinding = resourceBindings.get(left.id)!;
        const rightBinding = resourceBindings.get(right.id)!;
        return leftBinding.path.localeCompare(rightBinding.path) ||
          pointerSortKey(leftBinding.pointer).localeCompare(pointerSortKey(rightBinding.pointer));
      }),
    }];
  });
  const templates = applyCollectionCapabilities(sections, resourceBindings);
  const values = Object.fromEntries([...bindings.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((binding) => [binding.key, structuredClone(binding.value)]));
  const documentCas = Object.fromEntries(editable
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => [entry.path, entry.sourceSha256]));
  const cas: ConfigCas = {
    protocol: CONFIG_CAS_PROTOCOL,
    lifecycleGeneration: sourceCatalog.lifecycleGeneration,
    configurationSha256: sourceCatalog.configurationSha256,
    documents: documentCas,
  };
  return {
    catalog: { protocol: CONFIG_CATALOG_PROTOCOL, sections },
    snapshot: {
      protocol: CONFIG_SNAPSHOT_PROTOCOL,
      cas: cas as unknown as JsonValue,
      values,
    },
    documents,
    bindings,
    resources: resourceBindings,
    templates,
    sections: sectionDomains,
  };
}

function applyCollectionCapabilities(
  sections: ConfigSectionDefinition[],
  resources: ReadonlyMap<string, ConfigResourceBinding>,
): Map<string, ConfigTemplateBinding> {
  const templates = new Map<string, ConfigTemplateBinding>();
  const sectionByDomain = new Map<ProjectConfigSemanticDomain, ConfigSectionDefinition>();
  const definitions = new Map<string, ConfigResourceDefinition>();
  for (const section of sections) {
    const domain = SECTION_ORDER.find((candidate) => section.id === opaqueId("section", candidate));
    if (domain !== undefined) sectionByDomain.set(domain, section);
    for (const resource of section.resources) definitions.set(resource.id, resource);
  }
  for (const binding of resources.values()) {
    const cloneableDocument = binding.kind === "document" &&
      (binding.semanticDomain === "run-type" || binding.semanticDomain === "agent");
    if (!cloneableDocument && collectionIdentityField(binding) === undefined) continue;
    const definition = definitions.get(binding.id);
    const section = sectionByDomain.get(binding.semanticDomain);
    if (definition === undefined || section === undefined) continue;
    definition.canDuplicate = true;
    definition.canDelete = true;
    const templateId = opaqueId("template", binding.id);
    const parent = binding.kind === "array_item" && binding.parentId !== undefined
      ? definitions.get(binding.parentId)
      : undefined;
    const option = {
      id: templateId,
      title: `Based on ${binding.title}`,
      description: `Create a new ${domainNoun(binding.semanticDomain)} using ${binding.title} as its validated starting structure.`,
      nameLabel: binding.semanticDomain === "agent" ? "Agent name" :
        binding.semanticDomain === "run-type" ? "Run type name" : "Resource name",
      suggestedName: `New ${binding.title}`,
    };
    if (parent === undefined) {
      section.createOptions = [...(section.createOptions ?? []), option];
    } else {
      parent.createOptions = [...(parent.createOptions ?? []), option];
    }
    templates.set(templateId, {
      id: templateId,
      sectionId: section.id,
      resourceId: binding.id,
      ...(parent === undefined ? {} : { parentResourceId: parent.id }),
    });
  }
  return templates;
}

async function cloneBoundResource(
  current: ConfigSurfaceProjection,
  resourceId: string,
  rawName: string,
  projectRoot: string,
  profilePackageRoot: string,
  mutationMarker?: { id: string; requestSha256: Sha256Digest },
): Promise<ConfigSurfaceResourceMutationResult> {
  const binding = current.resources.get(resourceId);
  if (binding === undefined || !isCloneableResource(binding)) {
    throw new ConfigSurfaceError("config_resource_changed", "the selected configuration resource cannot be used as a template");
  }
  const { title, id } = normalizedResourceName(rawName);
  if (binding.kind === "document") {
    const newPath = `${binding.semanticDomain === "agent" ? "agents" : "run-types"}/${id}.yaml`;
    const cloned = renamedResource(binding.value, title, id);
    const documents: Array<{
      path: string;
      expectedSourceSha256: Sha256Digest | null;
      document: Record<string, unknown>;
    }> = [{ path: newPath, expectedSourceSha256: null, document: cloned }];
    if (binding.semanticDomain === "run-type") {
      documents.push(runTypeCatalogUpdate(current, binding, { id, path: newPath }));
    }
    await updateProjectAuthoredConfigDocuments({
      projectRoot,
      profilePackageRoot,
      documents,
      ...(mutationMarker === undefined ? {} : { mutationMarker }),
    });
    return refreshedMutationResult(projectRoot, profilePackageRoot, documents.length);
  }
  const source = current.documents.get(binding.path)!;
  const document = structuredClone(source.document);
  const parent = pointerValue(document, binding.pointer.slice(0, -1));
  const index = binding.pointer.at(-1);
  if (!Array.isArray(parent) || typeof index !== "number" || !isRecord(parent[index])) {
    throw new ConfigSurfaceError("config_resource_changed", "the selected configuration resource moved");
  }
  parent.splice(index + 1, 0, renamedResource(binding.value, title, id));
  await updateProjectAuthoredConfigDocuments({
    projectRoot,
    profilePackageRoot,
    documents: [{ path: binding.path, expectedSourceSha256: source.entry.sourceSha256, document }],
    ...(mutationMarker === undefined ? {} : { mutationMarker }),
  });
  return refreshedMutationResult(projectRoot, profilePackageRoot, 1);
}

function runTypeCatalogUpdate(
  current: ConfigSurfaceProjection,
  binding: ConfigResourceBinding,
  addition: { id: string; path: string } | undefined,
) {
  const project = current.documents.get("project.yaml");
  if (project === undefined || !Array.isArray(project.document.run_types)) {
    throw new ConfigSurfaceError("config_run_type_catalog", "the project run type catalog is unavailable");
  }
  const document = structuredClone(project.document);
  const sourceId = typeof binding.value.id === "string" ? binding.value.id : undefined;
  if (sourceId === undefined) throw new ConfigSurfaceError("config_run_type_catalog", "the run type has no stable identity");
  const entries = document.run_types as unknown[];
  if (addition === undefined) {
    const index = entries.findIndex((entry) => isRecord(entry) && entry.id === sourceId && entry.path === binding.path);
    if (index < 0) throw new ConfigSurfaceError("config_run_type_catalog", "the run type catalog changed");
    entries.splice(index, 1);
  } else {
    entries.push({ id: addition.id, path: addition.path });
  }
  return {
    path: project.entry.path,
    expectedSourceSha256: project.entry.sourceSha256,
    document,
  };
}

function renamedResource(value: Record<string, unknown>, title: string, id: string): Record<string, unknown> {
  const cloned = structuredClone(value);
  if (typeof cloned.id === "string") cloned.id = id;
  else if (typeof cloned.relation === "string") cloned.relation = id;
  if (typeof cloned.title === "string") cloned.title = title;
  if (typeof cloned.display_name === "string") cloned.display_name = title;
  if (typeof cloned.label === "string") cloned.label = title;
  if (typeof cloned.name === "string") cloned.name = title;
  return cloned;
}

function normalizedResourceName(raw: string): { title: string; id: string } {
  const title = raw.trim().replace(/\s+/gu, " ");
  if (title.length === 0 || title.length > 200) {
    throw new ConfigSurfaceError("config_resource_name", "resource name must contain between 1 and 200 characters");
  }
  const id = title.normalize("NFKD").toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 100)
    .replace(/-+$/gu, "");
  if (id.length === 0) throw new ConfigSurfaceError("config_resource_name", "resource name must contain letters or numbers");
  return { title, id };
}

function isCloneableResource(binding: ConfigResourceBinding): boolean {
  return collectionIdentityField(binding) !== undefined ||
    (binding.kind === "document" && (binding.semanticDomain === "agent" || binding.semanticDomain === "run-type"));
}

/**
 * Collection controls are intentionally semantic rather than YAML-shaped. Expressions, action
 * recipe primitives, run-type patch operations, and other internal arrays may contain mappings,
 * but cloning one of those mappings does not create a meaningful named resource. Only compiler
 * collections with a stable identity get Add/Duplicate/Delete controls. Project run-type catalog
 * rows are excluded because the run-type document operation updates that index atomically.
 */
function collectionIdentityField(binding: ConfigResourceBinding): "id" | "relation" | undefined {
  if (binding.kind !== "array_item" || typeof binding.pointer.at(-1) !== "number") return undefined;
  const collection = binding.pointer.at(-2);
  if (binding.semanticDomain === "project" && collection === "run_types") return undefined;
  if (typeof binding.value.id === "string" && binding.value.id.trim().length > 0) return "id";
  if (collection === "edge_types" &&
      typeof binding.value.relation === "string" && binding.value.relation.trim().length > 0) {
    return "relation";
  }
  return undefined;
}

function assertCurrentCas(current: ConfigSurfaceProjection, value: JsonValue): void {
  const supplied = parseCas(value);
  const expected = parseCas(current.snapshot.cas);
  if (JSON.stringify(supplied) !== JSON.stringify(expected)) {
    throw new ConfigSurfaceError("config_source_changed", "configuration changed since the editor was opened");
  }
}

async function refreshedMutationResult(
  projectRoot: string,
  profilePackageRoot: string,
  changedDocuments: number,
): Promise<ConfigSurfaceResourceMutationResult> {
  const current = await projectConfigSurface(projectRoot, profilePackageRoot);
  return { catalog: current.catalog, snapshot: current.snapshot, changedDocuments };
}

function pointerValue(root: unknown, pointer: readonly (string | number)[]): unknown {
  let cursor = root;
  for (const segment of pointer) {
    if (typeof segment === "number") {
      if (!Array.isArray(cursor) || cursor[segment] === undefined) return undefined;
      cursor = cursor[segment];
    } else {
      if (!isRecord(cursor) || cursor[segment] === undefined) return undefined;
      cursor = cursor[segment];
    }
  }
  return cursor;
}

function pointerSortKey(pointer: readonly (string | number)[]): string {
  return pointer.map((segment) => typeof segment === "number"
    ? `#${segment.toString().padStart(10, "0")}`
    : `.${segment}`).join("");
}

function projectResources(
  source: ProjectAuthoredConfigDocument,
  bindings: Map<string, ConfigFieldBinding>,
  resourceBindings: Map<string, ConfigResourceBinding>,
): ConfigResourceDefinition[] {
  const resources: ConfigResourceDefinition[] = [];
  const walk = (
    value: unknown,
    pointer: Array<string | number>,
    fallback: string,
    parentId: string | undefined,
    depth: number,
    kind: ConfigResourceBinding["kind"],
  ): void => {
    if (!isRecord(value)) return;
    const title = resourceTitle(value, fallback);
    const fields: ConfigFieldDefinition[] = [];
    const children: Array<{
      value: Record<string, unknown>;
      pointer: Array<string | number>;
      fallback: string;
      kind: ConfigResourceBinding["kind"];
    }> = [];
    for (const [name, child] of Object.entries(value)) {
      if (pointer.length === 0 && (name === "schema_version" || name === "module")) continue;
      const childPointer = [...pointer, name];
      if (source.entry.semanticDomain === "agent" && pointer.length === 0 && name === "instructions" && isRecord(child)) {
        for (const [instructionName, instructionValue] of Object.entries(child)) {
          const instructionPointer = [...childPointer, instructionName];
          const nested = fieldDefinition(
            source.entry,
            instructionPointer,
            instructionName === "text" ? "Prompt" : `Instructions ${instructionName}`,
            instructionValue,
          );
          if (nested === undefined) continue;
          if (bindings.has(nested.key)) throw new ConfigSurfaceError("config_key_collision", "configuration field identity collided");
          bindings.set(nested.key, {
            key: nested.key,
            path: source.entry.path,
            pointer: instructionPointer,
            definition: nested,
            value: structuredClone(instructionValue) as JsonValue,
          });
          fields.push(nested);
        }
        continue;
      }
      const definition = fieldDefinition(source.entry, childPointer, name, child);
      if (definition !== undefined) {
        if (bindings.has(definition.key)) throw new ConfigSurfaceError("config_key_collision", "configuration field identity collided");
        const binding: ConfigFieldBinding = {
          key: definition.key,
          path: source.entry.path,
          pointer: childPointer,
          definition,
          value: structuredClone(child) as JsonValue,
        };
        bindings.set(definition.key, binding);
        fields.push(definition);
      } else if (isRecord(child)) {
        children.push({ value: child, pointer: childPointer, fallback: humanize(name), kind: "nested" });
      } else if (Array.isArray(child) && child.some(isRecord)) {
        child.forEach((item, index) => {
          if (isRecord(item)) children.push({
            value: item,
            pointer: [...childPointer, index],
            fallback: `${humanize(name)} ${index + 1}`,
            kind: "array_item",
          });
        });
      }
    }
    let childParentId = parentId;
    let childDepth = depth;
    if (fields.length > 0) {
      const id = opaqueId("resource", source.entry.path, pointer);
      const definition: ConfigResourceDefinition = {
        id,
        title,
        description: typeof value.description === "string"
          ? value.description
          : `Configure ${title.toLocaleLowerCase()}.`,
        ...(parentId === undefined ? {} : { parentId }),
        depth,
        fields,
      };
      resources.push(definition);
      resourceBindings.set(id, {
        id,
        path: source.entry.path,
        pointer: [...pointer],
        ...(parentId === undefined ? {} : { parentId }),
        depth,
        title,
        semanticDomain: source.entry.semanticDomain,
        kind,
        value: structuredClone(value),
      });
      childParentId = id;
      childDepth = depth + 1;
    }
    for (const child of children) {
      walk(child.value, child.pointer, child.fallback, childParentId, childDepth, child.kind);
    }
  };
  walk(source.document, [], source.entry.label, undefined, 0, "document");
  return resources;
}

function fieldDefinition(
  entry: ProjectConfigCatalogEntry,
  pointer: Array<string | number>,
  name: string,
  value: unknown,
): ConfigFieldDefinition | undefined {
  const key = opaqueId("field", entry.path, pointer);
  const label = humanize(name);
  const description = `Configure ${label.toLocaleLowerCase()} for this ${domainNoun(entry.semanticDomain)}.`;
  if (typeof value === "boolean") return { key, label, description, kind: "boolean" };
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return { key, label, description, kind: "integer", minimum: 0 };
  }
  if (typeof value === "string") {
    if (name === "model") return { key, label, description, kind: "model" };
    if (name === "thinking_level" || name === "thinkingLevel") {
      return {
        key,
        label: "Reasoning",
        description,
        kind: "thinking",
        options: THINKING_LEVELS.map((level) => ({ value: level, label: humanize(level) })),
      };
    }
    return {
      key,
      label,
      description,
      kind: value.includes("\n") || value.length > 120 ? "multiline" : "text",
    };
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return { key, label, description, kind: "string_list" };
  }
  return undefined;
}

function normalizeFieldValue(value: JsonValue | undefined, field: ConfigFieldDefinition): JsonValue {
  if (value === undefined || value === null) {
    throw new ConfigSurfaceError("config_value", `${field.label} cannot be empty`);
  }
  if ((field.kind === "text" || field.kind === "multiline" || field.kind === "model" || field.kind === "thinking" || field.kind === "select") && typeof value !== "string") {
    throw new ConfigSurfaceError("config_value", `${field.label} must be text`);
  }
  if (field.kind === "integer" && (!Number.isSafeInteger(value) || typeof value !== "number")) {
    throw new ConfigSurfaceError("config_value", `${field.label} must be a whole number`);
  }
  if (field.kind === "boolean" && typeof value !== "boolean") {
    throw new ConfigSurfaceError("config_value", `${field.label} must be on or off`);
  }
  if (field.kind === "string_list" && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
    throw new ConfigSurfaceError("config_value", `${field.label} must be a list of text values`);
  }
  return structuredClone(value);
}

function setPointer(root: Record<string, unknown>, pointer: readonly (string | number)[], value: JsonValue): void {
  if (pointer.length === 0) throw new ConfigSurfaceError("config_pointer", "configuration field has no address");
  let cursor: unknown = root;
  for (const segment of pointer.slice(0, -1)) {
    if (typeof segment === "number") {
      if (!Array.isArray(cursor) || cursor[segment] === undefined) throw new ConfigSurfaceError("config_pointer", "configuration list changed");
      cursor = cursor[segment];
    } else {
      if (!isRecord(cursor) || cursor[segment] === undefined) throw new ConfigSurfaceError("config_pointer", "configuration object changed");
      cursor = cursor[segment];
    }
  }
  const leaf = pointer.at(-1)!;
  if (typeof leaf === "number") {
    if (!Array.isArray(cursor) || cursor[leaf] === undefined) throw new ConfigSurfaceError("config_pointer", "configuration list changed");
    cursor[leaf] = structuredClone(value);
  } else {
    if (!isRecord(cursor) || !(leaf in cursor)) throw new ConfigSurfaceError("config_pointer", "configuration object changed");
    cursor[leaf] = structuredClone(value);
  }
}

function parseCas(value: JsonValue): ConfigCas {
  if (!isRecord(value) || value.protocol !== CONFIG_CAS_PROTOCOL ||
      !Number.isSafeInteger(value.lifecycleGeneration) || typeof value.configurationSha256 !== "string" ||
      !isRecord(value.documents)) {
    throw new ConfigSurfaceError("config_cas", "configuration editor identity is invalid");
  }
  return structuredClone(value) as unknown as ConfigCas;
}

function opaqueId(kind: string, ...parts: unknown[]): string {
  return `${kind}-${rawSha256(JSON.stringify(parts)).slice("sha256:".length, "sha256:".length + 24)}`;
}

function resourceTitle(value: Record<string, unknown>, fallback: string): string {
  for (const candidate of [value.title, value.label, value.id, value.relation, value.type, value.kind]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return humanize(candidate);
  }
  return fallback;
}

function humanize(value: string): string {
  return value.split(/[._/-]+/u).filter(Boolean)
    .map((part) => `${part[0]?.toLocaleUpperCase() ?? ""}${part.slice(1).replaceAll("_", " ")}`)
    .join(" ");
}

function domainNoun(domain: ProjectConfigSemanticDomain): string {
  return SECTION_COPY[domain].title.toLocaleLowerCase().replace(/s$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
