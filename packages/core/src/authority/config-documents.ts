import YAML from "yaml";
import { compileProjectDirectory } from "../compiler/project-directory.js";
import type { ProfileFileKind } from "../contracts/profile-package.js";
import {
  catalogProjectAuthoredConfigSources,
  recoverProjectConfigMutationMarker,
  readProjectAuthoredConfigSource,
  updateProjectAuthoredConfigSources,
  ProjectConfigMutationError,
  type ProjectConfigSourceCatalog,
  type ProjectConfigSourceCatalogEntry,
  type ProjectConfigSourceFormat,
} from "../profile/config-edit.js";
import { loadProfilePackage } from "../profile/install.js";
import {
  canonicalHash,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import { parseStrictYamlObject } from "../shared/yaml.js";

export const CONFIG_DOCUMENT_CATALOG_PROTOCOL = "koni.config-document-catalog.v1" as const;
export const CONFIG_DOCUMENT_SOURCE_PROTOCOL = "koni.config-document-source.v1" as const;
export const CONFIG_DOCUMENT_MUTATION_PROTOCOL = "koni.config-document-mutation.v1" as const;
export const CONFIG_RUN_TYPE_TEMPLATES_PROTOCOL = "koni.config-run-type-templates.v1" as const;

export const CONFIG_DOCUMENT_DOMAINS = [
  "project",
  "run_types",
  "agents",
  "skills",
  "workflows_tickets",
  "graph_rules",
  "actions_checks",
  "reports_views",
  "advanced",
] as const;

export type ConfigDocumentDomain = (typeof CONFIG_DOCUMENT_DOMAINS)[number];

export const CONFIG_RESOURCE_KINDS = [
  "project",
  "profile",
  "initialization",
  "storage",
  "git",
  "orchestration",
  "run_type_catalog",
  "run_type",
  "codex_project_settings",
  "native_agent",
  "skill",
  "agent_policy",
  "persona",
  "markdown_prompt",
  "pipeline",
  "workflow",
  "ticket_operation",
  "lifecycle",
  "node_type",
  "edge_type",
  "gate_policy",
  "query",
  "rule",
  "action",
  "check",
  "run_card",
  "report",
  "view",
  "raw_source",
] as const;

export type ConfigResourceKind = (typeof CONFIG_RESOURCE_KINDS)[number];

export interface ConfigDocumentCapabilities {
  read: true;
  update: boolean;
  rename: boolean;
  delete: boolean;
  reason?: string;
}

export interface ConfigDocumentSummary {
  id: string;
  title: string;
  domain: ConfigDocumentDomain;
  kind: ConfigResourceKind;
  resourceKinds: readonly ConfigResourceKind[];
  format: ProjectConfigSourceFormat;
  sizeBytes: number;
  sourceToken: Sha256Digest;
  capabilities: ConfigDocumentCapabilities;
}

export interface ConfigDocumentCatalog {
  protocol: typeof CONFIG_DOCUMENT_CATALOG_PROTOCOL;
  catalogToken: Sha256Digest;
  profile: { id: string; version: string };
  valid: boolean;
  diagnostics: readonly string[];
  documents: readonly ConfigDocumentSummary[];
}

export interface ConfigDocumentSource {
  protocol: typeof CONFIG_DOCUMENT_SOURCE_PROTOCOL;
  catalogToken: Sha256Digest;
  document: ConfigDocumentSummary;
  source: string;
}

export interface ConfigDocumentMutationResult {
  protocol: typeof CONFIG_DOCUMENT_MUTATION_PROTOCOL;
  changedDocuments: number;
  catalog: ConfigDocumentCatalog;
}

export interface ConfigRunTypeTemplate {
  id: string;
  title: string;
  description: string;
}

export interface ConfigRunTypeTemplates {
  protocol: typeof CONFIG_RUN_TYPE_TEMPLATES_PROTOCOL;
  catalogToken: Sha256Digest;
  templates: readonly ConfigRunTypeTemplate[];
}

export interface ConfigDocumentAuthorityOptions {
  projectRoot: string;
  profilePackageRoot: string;
}

export interface ConfigAuthorityMutationMarker {
  id: string;
  requestSha256: Sha256Digest;
}

/**
 * Semantic Configure authority. Filesystem paths and source hashes never become
 * operator choices: callers round-trip opaque document/catalog tokens, while
 * this class re-resolves the canonical managed-profile inventory on every call.
 */
export class ConfigDocumentAuthority {
  readonly #projectRoot: string;
  readonly #profilePackageRoot: string;

  public constructor(options: ConfigDocumentAuthorityOptions) {
    this.#projectRoot = options.projectRoot;
    this.#profilePackageRoot = options.profilePackageRoot;
  }

  public async list(): Promise<ConfigDocumentCatalog> {
    return projectCatalog(
      await catalogProjectAuthoredConfigSources(this.#projectRoot, this.#profilePackageRoot),
    );
  }

  public async read(input: {
    documentId: string;
    catalogToken: Sha256Digest;
  }): Promise<ConfigDocumentSource> {
    const resolved = await this.#resolve(input.documentId, input.catalogToken);
    const source = await readProjectAuthoredConfigSource(
      this.#projectRoot,
      this.#profilePackageRoot,
      resolved.entry.path,
    );
    if (source.entry.sourceSha256 !== resolved.entry.sourceSha256) {
      throw new ConfigDocumentAuthorityError(
        "config_source_changed",
        "configuration changed while the document was opening",
      );
    }
    return {
      protocol: CONFIG_DOCUMENT_SOURCE_PROTOCOL,
      catalogToken: input.catalogToken,
      document: resolved.summary,
      source: source.source,
    };
  }

  public async update(input: {
    documentId: string;
    catalogToken: Sha256Digest;
    sourceToken: Sha256Digest;
    source: string;
    mutationMarker?: ConfigAuthorityMutationMarker;
  }): Promise<ConfigDocumentMutationResult> {
    const recovered = await this.#recoverIfCommitted(input.mutationMarker);
    if (recovered !== undefined) return recovered;
    const resolved = await this.#resolve(input.documentId, input.catalogToken, input.sourceToken);
    await updateProjectAuthoredConfigSources({
      projectRoot: this.#projectRoot,
      profilePackageRoot: this.#profilePackageRoot,
      sources: [
        {
          path: resolved.entry.path,
          expectedSourceSha256: resolved.entry.sourceSha256,
          source: input.source,
        },
      ],
      ...(input.mutationMarker === undefined ? {} : { mutationMarker: input.mutationMarker }),
    });
    return this.#mutationResult(1);
  }

  public async create(input: {
    catalogToken: Sha256Digest;
    domain: ConfigDocumentDomain;
    kind: ConfigResourceKind;
    format: ProjectConfigSourceFormat;
    title: string;
    source?: string;
    mutationMarker?: ConfigAuthorityMutationMarker;
  }): Promise<ConfigDocumentMutationResult> {
    const recovered = await this.#recoverIfCommitted(input.mutationMarker);
    if (recovered !== undefined) return recovered;
    const current = await this.#requireCatalog(input.catalogToken);
    assertDomain(input.domain);
    assertResourceKind(input.kind);
    const name = normalizedName(input.title);
    const descriptor = newDocumentDescriptor(input.domain, input.kind, input.format, name);
    const source = input.source ?? defaultDocumentSource(descriptor, name);
    if (current.source.entries.some((entry) => entry.path === descriptor.path)) {
      throw new ConfigDocumentAuthorityError(
        "config_document_exists",
        "a configuration document with that name already exists",
      );
    }
    await updateProjectAuthoredConfigSources({
      projectRoot: this.#projectRoot,
      profilePackageRoot: this.#profilePackageRoot,
      sources: [
        {
          path: descriptor.path,
          expectedSourceSha256: null,
          source,
          kind: descriptor.fileKind,
        },
      ],
      ...(input.mutationMarker === undefined ? {} : { mutationMarker: input.mutationMarker }),
    });
    return this.#mutationResult(1);
  }

  public async rename(input: {
    documentId: string;
    catalogToken: Sha256Digest;
    sourceToken: Sha256Digest;
    title: string;
    mutationMarker?: ConfigAuthorityMutationMarker;
  }): Promise<ConfigDocumentMutationResult> {
    const recovered = await this.#recoverIfCommitted(input.mutationMarker);
    if (recovered !== undefined) return recovered;
    const resolved = await this.#resolve(input.documentId, input.catalogToken, input.sourceToken);
    if (!resolved.summary.capabilities.rename) {
      throw new ConfigDocumentAuthorityError(
        "config_document_locked",
        resolved.summary.capabilities.reason ?? "this document cannot be renamed",
      );
    }
    const name = normalizedName(input.title);
    const nextPath = renamedDocumentPath(resolved.entry, resolved.summary.kind, name.slug);
    if (nextPath === resolved.entry.path) return this.#mutationResult(0);
    const sourceRead = await readProjectAuthoredConfigSource(
      this.#projectRoot,
      this.#profilePackageRoot,
      resolved.entry.path,
    );
    let source = sourceRead.source;
    const additionalSources: Array<{
      path: string;
      expectedSourceSha256: Sha256Digest;
      source: string;
    }> = [];
    if (resolved.summary.kind === "run_type") {
      source = renamedYamlIdentity(source, name, true);
      additionalSources.push(
        await this.#updatedProjectRunTypeCatalog({
          oldPath: resolved.entry.path,
          oldId: yamlIdentity(sourceRead.source),
          nextPath,
          nextId: name.slug,
        }),
      );
    } else if (resolved.summary.kind === "native_agent") {
      source = renamedYamlIdentity(source, name, false);
    } else if (resolved.summary.kind === "skill") {
      source = renamedSkillIdentity(source, name.slug);
    }
    await updateProjectAuthoredConfigSources({
      projectRoot: this.#projectRoot,
      profilePackageRoot: this.#profilePackageRoot,
      sources: [
        {
          path: nextPath,
          expectedSourceSha256: null,
          source,
          kind: resolved.entry.kind,
        },
        ...additionalSources,
      ],
      deletes: [{ path: resolved.entry.path, expectedSourceSha256: resolved.entry.sourceSha256 }],
      ...(input.mutationMarker === undefined ? {} : { mutationMarker: input.mutationMarker }),
    });
    return this.#mutationResult(additionalSources.length + 2);
  }

  public async delete(input: {
    documentId: string;
    catalogToken: Sha256Digest;
    sourceToken: Sha256Digest;
    mutationMarker?: ConfigAuthorityMutationMarker;
  }): Promise<ConfigDocumentMutationResult> {
    const recovered = await this.#recoverIfCommitted(input.mutationMarker);
    if (recovered !== undefined) return recovered;
    const resolved = await this.#resolve(input.documentId, input.catalogToken, input.sourceToken);
    if (!resolved.summary.capabilities.delete) {
      throw new ConfigDocumentAuthorityError(
        "config_document_locked",
        resolved.summary.capabilities.reason ?? "this document cannot be deleted",
      );
    }
    const sources: Array<{ path: string; expectedSourceSha256: Sha256Digest; source: string }> = [];
    if (resolved.summary.kind === "run_type") {
      const sourceRead = await readProjectAuthoredConfigSource(
        this.#projectRoot,
        this.#profilePackageRoot,
        resolved.entry.path,
      );
      sources.push(
        await this.#updatedProjectRunTypeCatalog({
          oldPath: resolved.entry.path,
          oldId: yamlIdentity(sourceRead.source),
        }),
      );
    }
    await updateProjectAuthoredConfigSources({
      projectRoot: this.#projectRoot,
      profilePackageRoot: this.#profilePackageRoot,
      sources,
      deletes: [{ path: resolved.entry.path, expectedSourceSha256: resolved.entry.sourceSha256 }],
      ...(input.mutationMarker === undefined ? {} : { mutationMarker: input.mutationMarker }),
    });
    return this.#mutationResult(sources.length + 1);
  }

  public async runTypeTemplates(): Promise<ConfigRunTypeTemplates> {
    const source = await catalogProjectAuthoredConfigSources(
      this.#projectRoot,
      this.#profilePackageRoot,
    );
    const catalog = projectCatalog(source);
    if (!catalog.valid) {
      throw new ConfigDocumentAuthorityError(
        "config_invalid",
        "repair the current configuration before creating a run type",
      );
    }
    const baseline = await loadProfilePackage(this.#profilePackageRoot);
    const compiled = await compileProjectDirectory(this.#projectRoot, baseline);
    if (!compiled.ok)
      throw new ConfigDocumentAuthorityError(
        "config_invalid",
        renderDiagnostics(compiled.diagnostics),
      );
    const templates = compiled.value.run_type_order.map((id) => {
      const runType = compiled.value.run_types[id]!;
      return {
        id: templateToken(catalog.catalogToken, id, runType.sha256),
        title: textValue(runType.source.title, id),
        description: textValue(runType.source.description, `Based on ${id}`),
      };
    });
    return {
      protocol: CONFIG_RUN_TYPE_TEMPLATES_PROTOCOL,
      catalogToken: catalog.catalogToken,
      templates,
    };
  }

  public async createRunType(input: {
    catalogToken: Sha256Digest;
    templateId: string;
    title: string;
    slug?: string;
    description?: string;
    makeDefault: boolean;
    mutationMarker?: ConfigAuthorityMutationMarker;
  }): Promise<ConfigDocumentMutationResult> {
    const recovered = await this.#recoverIfCommitted(input.mutationMarker);
    if (recovered !== undefined) return recovered;
    await this.#requireCatalog(input.catalogToken);
    const baseline = await loadProfilePackage(this.#profilePackageRoot);
    const compiled = await compileProjectDirectory(this.#projectRoot, baseline);
    if (!compiled.ok)
      throw new ConfigDocumentAuthorityError(
        "config_invalid",
        renderDiagnostics(compiled.diagnostics),
      );
    const name = normalizedName(input.title, input.slug);
    const selected = compiled.value.run_type_order
      .map((id) => compiled.value.run_types[id]!)
      .find(
        (runType) =>
          templateToken(input.catalogToken, runType.id, runType.sha256) === input.templateId,
      );
    if (selected === undefined) {
      throw new ConfigDocumentAuthorityError(
        "config_template_changed",
        "the selected run-type template is no longer current",
      );
    }
    const runPath = `run-types/${name.slug}.yaml`;
    const project = await readProjectAuthoredConfigSource(
      this.#projectRoot,
      this.#profilePackageRoot,
      "project.yaml",
    );
    const projectDocument = strictYaml(project.source, "project.yaml");
    const entries = projectDocument.run_types;
    if (!Array.isArray(entries))
      throw new ConfigDocumentAuthorityError(
        "config_run_type_catalog",
        "the run-type catalog is unavailable",
      );
    if (
      entries.some((entry) => isRecord(entry) && (entry.id === name.slug || entry.path === runPath))
    ) {
      throw new ConfigDocumentAuthorityError(
        "config_document_exists",
        "a run type with that title or slug already exists",
      );
    }
    entries.push({ id: name.slug, path: runPath });
    if (input.makeDefault) projectDocument.default_run_type = name.slug;
    const source = {
      schema_version: "2.0",
      ...structuredClone(selected.document),
      id: name.slug,
      title: name.title,
      description:
        input.description?.trim() ||
        `A ${name.title} workflow based on ${textValue(selected.source.title, selected.id)}.`,
    };
    await updateProjectAuthoredConfigSources({
      projectRoot: this.#projectRoot,
      profilePackageRoot: this.#profilePackageRoot,
      sources: [
        {
          path: project.entry.path,
          expectedSourceSha256: project.entry.sourceSha256,
          source: YAML.stringify(projectDocument, { lineWidth: 0 }),
        },
        {
          path: runPath,
          expectedSourceSha256: null,
          source: YAML.stringify(source, { lineWidth: 0 }),
          kind: "config",
        },
      ],
      ...(input.mutationMarker === undefined ? {} : { mutationMarker: input.mutationMarker }),
    });
    return this.#mutationResult(2);
  }

  /**
   * Reconstruct a committed semantic mutation result after the filesystem
   * transaction completed but before the outer authority receipt was stored.
   */
  public async recoverMutation(input: {
    mutationMarker: ConfigAuthorityMutationMarker;
  }): Promise<ConfigDocumentMutationResult | undefined> {
    assertMutationMarker(input.mutationMarker);
    const marker = await recoverProjectConfigMutationMarker(
      this.#projectRoot,
      input.mutationMarker.id,
    );
    if (marker === undefined) return undefined;
    if (marker.requestSha256 !== input.mutationMarker.requestSha256) {
      throw new ConfigDocumentAuthorityError(
        "config_mutation_replay",
        "configuration mutation identity was reused with different input",
      );
    }
    if (marker.changedDocuments === undefined || marker.result === undefined) {
      throw new ConfigDocumentAuthorityError(
        "config_mutation_result_missing",
        "the historical configuration marker cannot reconstruct an exact semantic result",
      );
    }
    const source = await catalogProjectAuthoredConfigSources(
      this.#projectRoot,
      this.#profilePackageRoot,
    );
    if (
      source.lifecycleGeneration !== marker.result.lifecycleGeneration ||
      source.sourceRevision !== marker.result.sourceRevision ||
      source.configurationSha256 !== marker.result.configurationSha256 ||
      source.effectiveBundleSha256 !== marker.result.effectiveBundleSha256 ||
      source.bundleSha256 !== marker.result.bundleSha256
    ) {
      throw new ConfigDocumentAuthorityError(
        "config_mutation_result_changed",
        "configuration advanced after the witnessed commit; the exact original result cannot be reconstructed",
      );
    }
    return {
      protocol: CONFIG_DOCUMENT_MUTATION_PROTOCOL,
      changedDocuments: marker.changedDocuments,
      catalog: projectCatalog(source),
    };
  }

  async #recoverIfCommitted(
    marker: ConfigAuthorityMutationMarker | undefined,
  ): Promise<ConfigDocumentMutationResult | undefined> {
    if (marker === undefined) return undefined;
    return this.recoverMutation({ mutationMarker: marker });
  }

  async #requireCatalog(
    token: Sha256Digest,
  ): Promise<{ source: ProjectConfigSourceCatalog; catalog: ConfigDocumentCatalog }> {
    const source = await catalogProjectAuthoredConfigSources(
      this.#projectRoot,
      this.#profilePackageRoot,
    );
    const catalog = projectCatalog(source);
    if (catalog.catalogToken !== token) {
      throw new ConfigDocumentAuthorityError(
        "config_source_changed",
        "configuration changed since this view was opened",
      );
    }
    return { source, catalog };
  }

  async #resolve(
    documentId: string,
    catalogToken: Sha256Digest,
    sourceToken?: Sha256Digest,
  ): Promise<{
    entry: ProjectConfigSourceCatalogEntry;
    summary: ConfigDocumentSummary;
  }> {
    const current = await this.#requireCatalog(catalogToken);
    const index = current.catalog.documents.findIndex((document) => document.id === documentId);
    if (index < 0)
      throw new ConfigDocumentAuthorityError(
        "config_document_changed",
        "the selected document is no longer available",
      );
    const summary = current.catalog.documents[index]!;
    if (sourceToken !== undefined && summary.sourceToken !== sourceToken) {
      throw new ConfigDocumentAuthorityError(
        "config_source_changed",
        "the selected document changed since it was opened",
      );
    }
    return { entry: current.source.entries[index]!, summary };
  }

  async #mutationResult(changedDocuments: number): Promise<ConfigDocumentMutationResult> {
    return {
      protocol: CONFIG_DOCUMENT_MUTATION_PROTOCOL,
      changedDocuments,
      catalog: await this.list(),
    };
  }

  async #updatedProjectRunTypeCatalog(input: {
    oldPath: string;
    oldId: string;
    nextPath?: string;
    nextId?: string;
  }): Promise<{ path: string; expectedSourceSha256: Sha256Digest; source: string }> {
    const project = await readProjectAuthoredConfigSource(
      this.#projectRoot,
      this.#profilePackageRoot,
      "project.yaml",
    );
    const document = strictYaml(project.source, "project.yaml");
    if (!Array.isArray(document.run_types)) {
      throw new ConfigDocumentAuthorityError(
        "config_run_type_catalog",
        "the run-type catalog is unavailable",
      );
    }
    const index = document.run_types.findIndex(
      (entry) => isRecord(entry) && entry.id === input.oldId && entry.path === input.oldPath,
    );
    if (index < 0)
      throw new ConfigDocumentAuthorityError(
        "config_run_type_catalog",
        "the run-type catalog changed",
      );
    if (input.nextPath === undefined || input.nextId === undefined) {
      if (document.run_types.length <= 1) {
        throw new ConfigDocumentAuthorityError(
          "config_run_type_required",
          "a project must keep at least one run type",
        );
      }
      document.run_types.splice(index, 1);
      if (document.default_run_type === input.oldId) {
        const replacement = document.run_types[0];
        if (!isRecord(replacement) || typeof replacement.id !== "string") {
          throw new ConfigDocumentAuthorityError(
            "config_run_type_catalog",
            "the remaining run-type catalog is invalid",
          );
        }
        document.default_run_type = replacement.id;
      }
    } else {
      document.run_types[index] = { id: input.nextId, path: input.nextPath };
      if (document.default_run_type === input.oldId) document.default_run_type = input.nextId;
    }
    return {
      path: project.entry.path,
      expectedSourceSha256: project.entry.sourceSha256,
      source: YAML.stringify(document, { lineWidth: 0 }),
    };
  }
}

export class ConfigDocumentAuthorityError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConfigDocumentAuthorityError";
  }
}

function projectCatalog(source: ProjectConfigSourceCatalog): ConfigDocumentCatalog {
  const catalogToken = canonicalHash({
    protocol: CONFIG_DOCUMENT_CATALOG_PROTOCOL,
    lifecycleGeneration: source.lifecycleGeneration,
    sourceRevision: source.sourceRevision,
    bundleSha256: source.bundleSha256,
  });
  return {
    protocol: CONFIG_DOCUMENT_CATALOG_PROTOCOL,
    catalogToken,
    profile: { id: source.profileId, version: source.profileVersion },
    valid: source.configurationSha256 !== null,
    diagnostics: [...source.diagnostics],
    documents: source.entries.map((entry) => documentSummary(entry, catalogToken)),
  };
}

function documentSummary(
  entry: ProjectConfigSourceCatalogEntry,
  catalogToken: Sha256Digest,
): ConfigDocumentSummary {
  const resourceKinds = resourceKindsFor(entry.path);
  const kind = resourceKinds[0] ?? "raw_source";
  const immutable = entry.path === "project.yaml" || entry.path === "profile.yaml";
  return {
    id: rawSha256(JSON.stringify(["config-document", entry.path])),
    title: entry.label,
    domain: domainFor(entry.path),
    kind,
    resourceKinds,
    format: entry.format,
    sizeBytes: entry.sizeBytes,
    sourceToken: canonicalHash({ catalogToken, path: entry.path, sha256: entry.sourceSha256 }),
    capabilities: {
      read: true,
      update: true,
      rename: !immutable,
      delete: !immutable,
      ...(immutable
        ? { reason: "This canonical project document must remain at its fixed location." }
        : {}),
    },
  };
}

function domainFor(relative: string): ConfigDocumentDomain {
  if (relative === "project.yaml" || relative === "profile.yaml") return "project";
  if (relative.startsWith("run-types/")) return "run_types";
  if (
    relative.startsWith("agents/") ||
    relative.startsWith("personas/") ||
    relative === "personas.yaml"
  )
    return "agents";
  if (relative.startsWith("resources/skills/") || relative.includes("/prompts/")) return "skills";
  if (
    relative.startsWith("workflows/") ||
    relative === "workflows.yaml" ||
    relative.startsWith("operations/") ||
    relative === "operations.yaml" ||
    relative.startsWith("lifecycle/") ||
    relative === "lifecycle.yaml"
  )
    return "workflows_tickets";
  if (
    relative.startsWith("graph/") ||
    relative === "graph.yaml" ||
    relative.startsWith("rules/") ||
    relative === "rules.yaml"
  )
    return "graph_rules";
  if (
    relative.startsWith("actions/") ||
    relative === "actions.yaml" ||
    relative.startsWith("checks/") ||
    relative === "checks.yaml"
  )
    return "actions_checks";
  if (
    relative.startsWith("reports/") ||
    relative === "reports.yaml" ||
    relative.startsWith("cockpit/") ||
    relative === "cockpit.yaml"
  )
    return "reports_views";
  return "advanced";
}

function resourceKindsFor(relative: string): ConfigResourceKind[] {
  if (relative === "project.yaml") return ["project", "run_type_catalog"];
  if (relative === "profile.yaml")
    return ["profile", "initialization", "storage", "git", "orchestration"];
  if (relative.startsWith("run-types/")) return ["run_type", "pipeline", "run_card"];
  if (relative.startsWith("agents/")) return ["native_agent", "agent_policy"];
  if (relative.startsWith("resources/skills/") && relative.endsWith("/SKILL.md")) return ["skill"];
  if (relative.includes("/prompts/") && relative.endsWith(".md")) return ["markdown_prompt"];
  if (relative.startsWith("personas/") || relative === "personas.yaml") return ["persona"];
  if (relative.startsWith("workflows/") || relative === "workflows.yaml") return ["workflow"];
  if (relative.startsWith("operations/") || relative === "operations.yaml")
    return ["ticket_operation"];
  if (relative.startsWith("lifecycle/") || relative === "lifecycle.yaml") return ["lifecycle"];
  if (relative.startsWith("graph/") || relative === "graph.yaml")
    return ["node_type", "edge_type", "gate_policy", "query"];
  if (relative.startsWith("rules/") || relative === "rules.yaml") return ["rule", "query"];
  if (relative.startsWith("actions/") || relative === "actions.yaml") return ["action"];
  if (relative.startsWith("checks/") || relative === "checks.yaml") return ["check"];
  if (relative.startsWith("reports/") || relative === "reports.yaml") return ["report"];
  if (relative.startsWith("cockpit/") || relative === "cockpit.yaml") return ["view"];
  return ["raw_source"];
}

function normalizedName(rawTitle: string, rawSlug?: string): { title: string; slug: string } {
  const title = rawTitle.trim().replace(/\s+/gu, " ");
  if (title.length < 1 || title.length > 200) {
    throw new ConfigDocumentAuthorityError(
      "config_document_name",
      "document title must contain between 1 and 200 characters",
    );
  }
  const candidate = rawSlug === undefined ? title : rawSlug.trim();
  const slug = candidate
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 100)
    .replace(/-+$/gu, "");
  if (slug.length === 0 || (rawSlug !== undefined && slug !== rawSlug.trim())) {
    throw new ConfigDocumentAuthorityError(
      "config_document_slug",
      "document slug must use lowercase letters, numbers, and single hyphens",
    );
  }
  return { title, slug };
}

function newDocumentDescriptor(
  domain: ConfigDocumentDomain,
  kind: ConfigResourceKind,
  format: ProjectConfigSourceFormat,
  name: { title: string; slug: string },
): { path: string; fileKind: ProfileFileKind; format: ProjectConfigSourceFormat } {
  if (domain === "agents" && kind === "native_agent" && format === "yaml") {
    return { path: `agents/${name.slug}.yaml`, fileKind: "agent", format };
  }
  if (domain === "skills" && kind === "skill" && format === "markdown") {
    return { path: `resources/skills/${name.slug}/SKILL.md`, fileKind: "skill", format };
  }
  if (domain === "skills" && kind === "markdown_prompt" && format === "markdown") {
    return { path: `resources/prompts/${name.slug}.md`, fileKind: "prompt", format };
  }
  if (domain === "advanced" && kind === "raw_source") {
    const extension = format === "yaml" ? "yaml" : format === "markdown" ? "md" : "toml";
    return {
      path: `custom/${name.slug}.${extension}`,
      fileKind: format === "yaml" ? "config" : "other",
      format,
    };
  }
  if (kind === "run_type") {
    throw new ConfigDocumentAuthorityError(
      "config_run_type_wizard",
      "create run types through the run-type wizard",
    );
  }
  throw new ConfigDocumentAuthorityError(
    "config_document_kind",
    "that semantic resource is not a standalone document type",
  );
}

function defaultDocumentSource(
  descriptor: { path: string; fileKind: ProfileFileKind; format: ProjectConfigSourceFormat },
  name: { title: string; slug: string },
): string {
  if (descriptor.fileKind === "agent") {
    return YAML.stringify(
      {
        schema_version: "2.0",
        id: name.slug,
        description: `${name.title} agent.`,
        instructions: { source: "inline", text: `Act as the ${name.title} agent.` },
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        thinking_level: "medium",
        capabilities: {
          workspace_access: "read_only",
          commands: "read_only",
          network_access: false,
        },
      },
      { lineWidth: 0 },
    );
  }
  if (descriptor.fileKind === "skill") {
    return `---\nname: ${name.slug}\ndescription: ${name.title}\n---\n\n# ${name.title}\n`;
  }
  if (descriptor.fileKind === "prompt") return `# ${name.title}\n`;
  if (descriptor.format === "yaml")
    return YAML.stringify({ schema_version: "2.0", id: name.slug, title: name.title });
  if (descriptor.format === "toml")
    return `id = ${JSON.stringify(name.slug)}\ntitle = ${JSON.stringify(name.title)}\n`;
  return `# ${name.title}\n`;
}

function renamedDocumentPath(
  entry: ProjectConfigSourceCatalogEntry,
  kind: ConfigResourceKind,
  slug: string,
): string {
  if (kind === "run_type") return `run-types/${slug}.yaml`;
  if (kind === "native_agent") return `agents/${slug}.yaml`;
  if (kind === "skill") return `resources/skills/${slug}/SKILL.md`;
  if (kind === "markdown_prompt") return `resources/prompts/${slug}.md`;
  const directory = entry.path.includes("/")
    ? entry.path.slice(0, entry.path.lastIndexOf("/") + 1)
    : "";
  const extension = entry.format === "yaml" ? "yaml" : entry.format === "markdown" ? "md" : "toml";
  return `${directory}${slug}.${extension}`;
}

function renamedYamlIdentity(
  source: string,
  name: { title: string; slug: string },
  includeTitle: boolean,
): string {
  const document = strictYaml(source, "configuration document");
  document.id = name.slug;
  if (includeTitle) document.title = name.title;
  return YAML.stringify(document, { lineWidth: 0 });
}

function renamedSkillIdentity(source: string, slug: string): string {
  if (!source.startsWith("---\n")) {
    throw new ConfigDocumentAuthorityError(
      "config_skill_frontmatter",
      "the skill has no editable YAML frontmatter",
    );
  }
  const delimiter = "\n---\n";
  const closing = source.indexOf(delimiter, 4);
  if (closing < 0) {
    throw new ConfigDocumentAuthorityError(
      "config_skill_frontmatter",
      "the skill frontmatter is incomplete",
    );
  }
  const header = source.slice(4, closing).split("\n");
  const nameIndex = header.findIndex((line) => /^name\s*:/u.test(line));
  if (nameIndex < 0) {
    throw new ConfigDocumentAuthorityError(
      "config_skill_frontmatter",
      "the skill frontmatter has no name",
    );
  }
  header[nameIndex] = `name: ${slug}`;
  return `---\n${header.join("\n")}\n---\n${source.slice(closing + delimiter.length)}`;
}

function yamlIdentity(source: string): string {
  const document = strictYaml(source, "configuration document");
  if (typeof document.id !== "string" || document.id.trim().length === 0) {
    throw new ConfigDocumentAuthorityError(
      "config_document_identity",
      "the configuration document has no stable identity",
    );
  }
  return document.id;
}

function strictYaml(source: string, label: string): Record<string, unknown> {
  const parsed = parseStrictYamlObject(source);
  if (!parsed.ok)
    throw new ConfigDocumentAuthorityError(
      "config_yaml_invalid",
      `${label} is invalid: ${renderDiagnostics(parsed.diagnostics)}`,
    );
  return structuredClone(parsed.value);
}

function templateToken(catalogToken: Sha256Digest, id: string, sha256: Sha256Digest): string {
  return rawSha256(JSON.stringify(["run-type-template", catalogToken, id, sha256]));
}

function assertDomain(value: string): asserts value is ConfigDocumentDomain {
  if (!CONFIG_DOCUMENT_DOMAINS.includes(value as ConfigDocumentDomain)) {
    throw new ConfigDocumentAuthorityError(
      "config_document_domain",
      "unsupported configuration domain",
    );
  }
}

function assertResourceKind(value: string): asserts value is ConfigResourceKind {
  if (!CONFIG_RESOURCE_KINDS.includes(value as ConfigResourceKind)) {
    throw new ConfigDocumentAuthorityError(
      "config_document_kind",
      "unsupported configuration resource kind",
    );
  }
}

function assertMutationMarker(value: ConfigAuthorityMutationMarker): void {
  if (!/^[a-f0-9]{64}$/u.test(value.id) || !isSha256Digest(value.requestSha256)) {
    throw new ConfigDocumentAuthorityError(
      "config_mutation_marker",
      "configuration mutation marker is invalid",
    );
  }
}

function textValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function renderDiagnostics(
  diagnostics: readonly { path: string; code: string; message: string }[],
): string {
  return diagnostics
    .map((diagnostic) => `${diagnostic.path}:${diagnostic.code}:${diagnostic.message}`)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep canonical mutation codes intact across the standalone service boundary. */
export function configDocumentError(error: unknown): ConfigDocumentAuthorityError {
  if (error instanceof ConfigDocumentAuthorityError) return error;
  if (error instanceof ProjectConfigMutationError)
    return new ConfigDocumentAuthorityError(error.code, error.message);
  return new ConfigDocumentAuthorityError(
    "config_document_failed",
    error instanceof Error ? error.message : String(error),
  );
}
