import type {
  CompiledConfiguration,
  ConfigurationObject,
  ConfigurationValue,
} from "../contracts/configuration.js";
import {
  canonicalHash,
  compareUtf8,
  isSha256Digest,
  type Sha256Digest,
} from "../shared/canonical.js";

export const COMPILED_COCKPIT_CATALOG_PROTOCOL = "koni.compiled-cockpit-catalog.v1" as const;

export const COCKPIT_VIEW_KINDS = [
  "kanban",
  "graph",
  "table",
  "status_overlay",
  "summary",
  "tabbed_table",
  "nested_detail",
  "typed_tree",
  "controls",
] as const;

export type CockpitViewKind = (typeof COCKPIT_VIEW_KINDS)[number];

export type CompiledCockpitSource =
  | Readonly<{ kind: "tickets"; mode: "all" }>
  | Readonly<{ kind: "graph"; scope: "selection" | "main_checkout" }>
  | Readonly<{ kind: "state"; fields: readonly string[] }>
  | Readonly<{ kind: "selection"; viewId: string }>
  | Readonly<{ kind: "codex"; feeds: readonly string[]; correlateBy: readonly string[] }>
  | Readonly<{ kind: "file"; path: string }>;

export interface CompiledCockpitColumn {
  readonly id: string;
  readonly value: string;
}

export interface CompiledCockpitView {
  readonly id: string;
  readonly title: string;
  readonly kind: CockpitViewKind;
  readonly source: CompiledCockpitSource;
  readonly columns: readonly CompiledCockpitColumn[];
  /** Presentation aliases only. Authority capabilities remain the action boundary. */
  readonly actions: readonly string[];
  readonly options: Readonly<Record<string, ConfigurationValue>>;
}

export interface CompiledCockpitViewCatalogMaterial {
  readonly protocol: typeof COMPILED_COCKPIT_CATALOG_PROTOCOL;
  readonly configurationSha256: Sha256Digest;
  readonly views: readonly CompiledCockpitView[];
}

export interface CompiledCockpitViewCatalog extends CompiledCockpitViewCatalogMaterial {
  readonly catalogSha256: Sha256Digest;
}

export interface CockpitCatalogResolutionRequest {
  readonly runId: string;
  readonly configurationSha256: Sha256Digest;
}

/**
 * Injected read-only handoff for the exact configuration artifact pinned by a
 * run. Implementations must not resolve current project YAML or ambient files.
 */
export interface ControlCenterCockpitCatalogResolver {
  resolve(request: CockpitCatalogResolutionRequest): Promise<unknown>;
}

export class CockpitConfigurationError extends Error {
  public readonly path: string;

  public constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "CockpitConfigurationError";
    this.path = path;
  }
}

/** Project the only cockpit vocabulary the native surfaces actually consume. */
export function projectCompiledCockpitViewCatalog(
  configuration: CompiledConfiguration,
): CompiledCockpitViewCatalog {
  if (!isSha256Digest(configuration.configuration_sha256)) {
    throw new CockpitConfigurationError("$.configuration_sha256", "expected a canonical sha256 digest");
  }
  const records = Object.entries(configuration.registries.views);
  if (records.length > 64) throw new CockpitConfigurationError("$.registries.views", "at most 64 views are supported");
  const views = records
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([registryId, value], index) => compileView(value, `$.registries.views/${registryId}`, registryId, index));
  ensureUnique(views.map((view) => view.id), "$.registries.views", "view id");
  for (const view of views) {
    const selectionViewId = view.source.kind === "selection" ? view.source.viewId : undefined;
    if (selectionViewId !== undefined && !views.some((candidate) => candidate.id === selectionViewId)) {
      throw new CockpitConfigurationError(
        `$.registries.views/${view.id}/source/selection_from`,
        `references unknown view ${selectionViewId}`,
      );
    }
  }
  const material: CompiledCockpitViewCatalogMaterial = {
    protocol: COMPILED_COCKPIT_CATALOG_PROTOCOL,
    configurationSha256: configuration.configuration_sha256,
    views,
  };
  return deepFreeze({ ...material, catalogSha256: canonicalHash(material) });
}

/** Validate an injected DTO and bind it to the run's exact configuration hash. */
export function parseCompiledCockpitViewCatalog(
  value: unknown,
  expectedConfigurationSha256: Sha256Digest,
): CompiledCockpitViewCatalog {
  const root = exactRecord(value, "$", ["protocol", "configurationSha256", "views", "catalogSha256"]);
  if (root.protocol !== COMPILED_COCKPIT_CATALOG_PROTOCOL) {
    throw new CockpitConfigurationError("$.protocol", "unsupported cockpit catalog protocol");
  }
  if (root.configurationSha256 !== expectedConfigurationSha256) {
    throw new CockpitConfigurationError("$.configurationSha256", "catalog is not bound to the selected run configuration");
  }
  if (!isSha256Digest(root.configurationSha256) || !isSha256Digest(root.catalogSha256)) {
    throw new CockpitConfigurationError("$", "catalog digests are malformed");
  }
  const rows = boundedArray(root.views, "$.views", 64);
  const views = rows.map((row, index) => parseProjectedView(row, `$.views/${index}`));
  ensureUnique(views.map((view) => view.id), "$.views", "view id");
  for (const view of views) {
    const selectionViewId = view.source.kind === "selection" ? view.source.viewId : undefined;
    if (selectionViewId !== undefined && !views.some((candidate) => candidate.id === selectionViewId)) {
      throw new CockpitConfigurationError(`$.views/${view.id}/source/viewId`, "references an unknown view");
    }
  }
  const material: CompiledCockpitViewCatalogMaterial = {
    protocol: COMPILED_COCKPIT_CATALOG_PROTOCOL,
    configurationSha256: root.configurationSha256,
    views,
  };
  if (canonicalHash(material) !== root.catalogSha256) {
    throw new CockpitConfigurationError("$.catalogSha256", "catalog content does not match its digest");
  }
  return deepFreeze({ ...material, catalogSha256: root.catalogSha256 });
}

export function cockpitView(
  catalog: CompiledCockpitViewCatalog | undefined,
  kinds: readonly CockpitViewKind[],
): CompiledCockpitView | undefined {
  return catalog?.views.find((view) => kinds.includes(view.kind));
}

export function cockpitStringArrayOption(
  view: CompiledCockpitView | undefined,
  key: string,
): readonly string[] | undefined {
  const value = view?.options[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value as readonly string[]
    : undefined;
}

export function cockpitStringOption(
  view: CompiledCockpitView | undefined,
  key: string,
): string | undefined {
  const value = view?.options[key];
  return typeof value === "string" ? value : undefined;
}

export function cockpitBooleanOption(
  view: CompiledCockpitView | undefined,
  key: string,
  fallback: boolean,
): boolean {
  const value = view?.options[key];
  return typeof value === "boolean" ? value : fallback;
}

export function cockpitIntegerOption(
  view: CompiledCockpitView | undefined,
  key: string,
): number | undefined {
  const value = view?.options[key];
  return Number.isSafeInteger(value) ? value as number : undefined;
}

export function cockpitStringMapOption(
  view: CompiledCockpitView | undefined,
  key: string,
): Readonly<Record<string, string>> | undefined {
  const value = view?.options[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.values(value).every((entry) => typeof entry === "string")
    ? value as Readonly<Record<string, string>>
    : undefined;
}

export function cockpitStringArrayMapOption(
  view: CompiledCockpitView | undefined,
  key: string,
): Readonly<Record<string, readonly string[]>> | undefined {
  const value = view?.options[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.values(value).every((entry) =>
    Array.isArray(entry) && entry.every((item) => typeof item === "string"))
    ? value as Readonly<Record<string, readonly string[]>>
    : undefined;
}

function compileView(
  value: ConfigurationObject,
  path: string,
  registryId: string,
  _index: number,
): CompiledCockpitView {
  const row = exactConfigurationRecord(value, path, ["id", "title", "kind", "source", "columns", "actions", "options"]);
  const id = identifier(row.id, `${path}/id`);
  if (id !== registryId) throw new CockpitConfigurationError(`${path}/id`, "must match its registry key");
  const kind = viewKind(row.kind, `${path}/kind`);
  const source = compileSource(row.source, `${path}/source`);
  validateSourceForKind(kind, source, `${path}/source`);
  const columns = compileColumns(row.columns, kind, `${path}/columns`);
  const actions = identifierArray(row.actions, `${path}/actions`, 64, true);
  ensureUnique(actions, `${path}/actions`, "action");
  const options = compileOptions(row.options, kind, `${path}/options`);
  return deepFreeze({
    id,
    title: safeText(row.title, `${path}/title`, 96),
    kind,
    source,
    columns,
    actions,
    options,
  });
}

function compileSource(value: ConfigurationValue | undefined, path: string): CompiledCockpitSource {
  if (value === "tickets") return { kind: "tickets", mode: "all" };
  if (value === "graph") return { kind: "graph", scope: "selection" };
  const row = configurationRecord(value, path);
  const keys = Object.keys(row).sort(compareUtf8);
  if (sameKeys(keys, ["state"])) {
    return { kind: "state", fields: identifierArray(row.state, `${path}/state`, 32, false) };
  }
  if (sameKeys(keys, ["tickets"])) {
    if (row.tickets !== "all") throw new CockpitConfigurationError(`${path}/tickets`, "only the all ticket source is supported");
    return { kind: "tickets", mode: "all" };
  }
  if (sameKeys(keys, ["selection_from"])) {
    return { kind: "selection", viewId: identifier(row.selection_from, `${path}/selection_from`) };
  }
  if (sameKeys(keys, ["graph"])) {
    if (row.graph !== "main_checkout") throw new CockpitConfigurationError(`${path}/graph`, "unsupported graph scope");
    return { kind: "graph", scope: "main_checkout" };
  }
  if (sameKeys(keys, ["codex", "correlate_by"])) {
    return {
      kind: "codex",
      feeds: identifierArray(row.codex, `${path}/codex`, 16, false),
      correlateBy: identifierArray(row.correlate_by, `${path}/correlate_by`, 16, false),
    };
  }
  if (sameKeys(keys, ["file"])) {
    const file = safeText(row.file, `${path}/file`, 256);
    if (file.startsWith("/") || file.includes("..") || file.includes("\\")) {
      throw new CockpitConfigurationError(`${path}/file`, "must be a normalized project-relative path");
    }
    return { kind: "file", path: file };
  }
  throw new CockpitConfigurationError(path, "unsupported source shape");
}

function validateSourceForKind(kind: CockpitViewKind, source: CompiledCockpitSource, path: string): void {
  const allowed: Readonly<Record<CockpitViewKind, readonly CompiledCockpitSource["kind"][]>> = {
    kanban: ["tickets"],
    graph: ["graph"],
    table: ["graph"],
    status_overlay: ["tickets", "codex"],
    summary: ["state"],
    tabbed_table: ["tickets"],
    nested_detail: ["selection"],
    typed_tree: ["graph"],
    controls: ["file"],
  };
  if (!allowed[kind].includes(source.kind)) {
    throw new CockpitConfigurationError(path, `${source.kind} is not a supported source for ${kind}`);
  }
}

const COLUMN_IDS: Readonly<Record<CockpitViewKind, Readonly<Record<string, string>>>> = {
  kanban: {},
  graph: {},
  table: {},
  status_overlay: {
    ticket: "$row.ticket_id",
    persona: "$row.persona",
    state: "$row.state",
    age: "$row.age",
  },
  summary: {
    health: "$row.validation.health",
    branch: "$row.branch",
    queues: "$row.queues",
    compiled: "$row.latest_fixpoint",
    agents: "$row.agents",
  },
  tabbed_table: {
    operation: "$row.operation",
    agents: "$row.attached_agents",
    steps: "$row.step_progress",
  },
  nested_detail: {
    lifecycle: "$row.lifecycle",
    scope: "$row.graph_scope.write",
    review: "$row.review_and_receipts",
    scratch_commits: "$row.git.scratch_commit_graph",
  },
  typed_tree: {
    type: "$row.type",
    primary_parent: "$row.visual_parent",
    secondary_edges: "$row.secondary_edges",
  },
  controls: {},
};

function compileColumns(
  value: ConfigurationValue | undefined,
  kind: CockpitViewKind,
  path: string,
): readonly CompiledCockpitColumn[] {
  if (value === undefined) return [];
  const rows = configurationArray(value, path, 32);
  const allowed = COLUMN_IDS[kind];
  const columns = rows.map((value, index) => {
    const row = exactConfigurationRecord(value, `${path}/${index}`, ["id", "value"]);
    const id = identifier(row.id, `${path}/${index}/id`);
    const expression = safeText(row.value, `${path}/${index}/value`, 128);
    if (allowed[id] !== expression) {
      throw new CockpitConfigurationError(`${path}/${index}`, `column ${id} is not a supported ${kind} projection`);
    }
    return { id, value: expression };
  });
  ensureUnique(columns.map((column) => column.id), path, "column id");
  return columns;
}

function compileOptions(
  value: ConfigurationValue | undefined,
  kind: CockpitViewKind,
  path: string,
): Readonly<Record<string, ConfigurationValue>> {
  const row = value === undefined ? {} : configurationRecord(value, path);
  const allowed = OPTION_KEYS[kind];
  rejectUnknownKeys(row, path, allowed);
  const output: Record<string, ConfigurationValue> = {};
  for (const [key, option] of Object.entries(row).sort(([left], [right]) => compareUtf8(left, right))) {
    output[key] = compileOption(kind, key, option, `${path}/${key}`);
  }
  return deepFreeze(output);
}

const OPTION_KEYS: Readonly<Record<CockpitViewKind, readonly string[]>> = {
  kanban: ["group_by", "show_step_progress", "show_scope_conflicts"],
  graph: ["layout", "upward_edge_policy", "hierarchy", "primary_parent_preferences", "reverse_display_edges", "secondary_edge_style", "show_titles"],
  table: ["node_types", "show_receipt_freshness"],
  status_overlay: ["stale_seconds", "completion_marker", "detached_agents_in_status_only"],
  summary: ["event_limit", "invalid_state_visible", "attention_conditions"],
  tabbed_table: ["tabs", "default_tab", "active_states", "show_raw_ids", "worktree_states", "agent_active_glyph", "step_glyphs"],
  nested_detail: ["sections", "recent_ticket_events", "scope_mode", "gate_preview", "show_context_receipts", "show_runtime_receipts"],
  typed_tree: ["layout", "upward_edge_policy", "hierarchy", "primary_parent_preferences", "reverse_display_edges", "secondary_edge_style", "show_titles"],
  controls: ["controls", "keybindings", "compiler_effect"],
};

function compileOption(kind: CockpitViewKind, key: string, value: ConfigurationValue, path: string): ConfigurationValue {
  if (["show_step_progress", "show_scope_conflicts", "show_receipt_freshness", "invalid_state_visible", "show_raw_ids",
    "detached_agents_in_status_only", "show_context_receipts", "show_runtime_receipts", "show_titles"].includes(key)) {
    return booleanValue(value, path);
  }
  if (["event_limit", "recent_ticket_events", "stale_seconds"].includes(key)) {
    return boundedInteger(value, path, 1, key === "stale_seconds" ? 86_400 : 100);
  }
  if (["hierarchy", "node_types", "attention_conditions", "tabs", "active_states", "worktree_states", "sections", "controls"].includes(key)) {
    const values = identifierArray(value, path, 64, false);
    ensureUnique(values, path, "option value");
    if (key === "tabs") {
      const supported = new Set(["all", "active", "todo", "blocked", "proposed", "closed", "other"]);
      for (const tab of values) if (!supported.has(tab)) throw new CockpitConfigurationError(path, `unsupported ticket tab ${tab}`);
    }
    return values;
  }
  if (key === "primary_parent_preferences") return stringMap(value, path, true);
  if (key === "reverse_display_edges") return stringMap(value, path, false);
  if (key === "keybindings") return safeStringMap(value, path);
  if (key === "step_glyphs") return glyphMap(value, path);
  if (key === "agent_active_glyph") {
    const glyph = safeText(value, path, 4);
    if (Array.from(glyph).length !== 1) throw new CockpitConfigurationError(path, "must contain one visible glyph");
    return glyph;
  }
  const text = safeText(value, path, 128);
  const literals: Readonly<Record<string, readonly string[]>> = {
    group_by: ["status"],
    layout: ["nested"],
    upward_edge_policy: ["mapped_only"],
    secondary_edge_style: ["independent_right_lanes"],
    completion_marker: ["task_complete"],
    default_tab: ["all", "active", "todo", "blocked", "proposed", "closed", "other"],
    scope_mode: ["write_only"],
    gate_preview: ["compact"],
    compiler_effect: ["paused-full-compile-is-read-only"],
  };
  if (literals[key] !== undefined && !literals[key]!.includes(text)) {
    throw new CockpitConfigurationError(path, `unsupported ${key} value`);
  }
  if (kind === "tabbed_table" && key === "default_tab") return text;
  return text;
}

function parseProjectedView(value: unknown, path: string): CompiledCockpitView {
  const row = exactRecord(value, path, ["id", "title", "kind", "source", "columns", "actions", "options"]);
  const id = identifier(row.id, `${path}/id`);
  const kind = viewKind(row.kind, `${path}/kind`);
  const source = parseProjectedSource(row.source, `${path}/source`);
  validateSourceForKind(kind, source, `${path}/source`);
  const columns = compileColumns(row.columns as ConfigurationValue, kind, `${path}/columns`);
  const actions = identifierArray(row.actions as ConfigurationValue, `${path}/actions`, 64, true);
  const options = compileOptions(row.options as ConfigurationValue, kind, `${path}/options`);
  return { id, title: safeText(row.title, `${path}/title`, 96), kind, source, columns, actions, options };
}

function parseProjectedSource(value: unknown, path: string): CompiledCockpitSource {
  const row = record(value, path);
  const kind = safeText(row.kind, `${path}/kind`, 32);
  if (kind === "tickets") {
    exactKeys(row, path, ["kind", "mode"]);
    if (row.mode !== "all") throw new CockpitConfigurationError(`${path}/mode`, "unsupported ticket source mode");
    return { kind, mode: "all" };
  }
  if (kind === "graph") {
    exactKeys(row, path, ["kind", "scope"]);
    if (row.scope !== "selection" && row.scope !== "main_checkout") throw new CockpitConfigurationError(`${path}/scope`, "unsupported graph scope");
    return { kind, scope: row.scope };
  }
  if (kind === "state") {
    exactKeys(row, path, ["kind", "fields"]);
    return { kind, fields: identifierArray(row.fields as ConfigurationValue, `${path}/fields`, 32, false) };
  }
  if (kind === "selection") {
    exactKeys(row, path, ["kind", "viewId"]);
    return { kind, viewId: identifier(row.viewId, `${path}/viewId`) };
  }
  if (kind === "codex") {
    exactKeys(row, path, ["kind", "feeds", "correlateBy"]);
    return {
      kind,
      feeds: identifierArray(row.feeds as ConfigurationValue, `${path}/feeds`, 16, false),
      correlateBy: identifierArray(row.correlateBy as ConfigurationValue, `${path}/correlateBy`, 16, false),
    };
  }
  if (kind === "file") {
    exactKeys(row, path, ["kind", "path"]);
    return { kind, path: safeText(row.path, `${path}/path`, 256) };
  }
  throw new CockpitConfigurationError(`${path}/kind`, "unsupported projected source kind");
}

function viewKind(value: unknown, path: string): CockpitViewKind {
  const kind = safeText(value, path, 32);
  if (!(COCKPIT_VIEW_KINDS as readonly string[]).includes(kind)) {
    throw new CockpitConfigurationError(path, `unsupported view kind ${kind}`);
  }
  return kind as CockpitViewKind;
}

function identifier(value: unknown, path: string): string {
  const text = safeText(value, path, 128);
  if (!/^[a-z][a-z0-9_.-]*$/u.test(text)) throw new CockpitConfigurationError(path, "expected a lowercase identifier");
  return text;
}

function identifierArray(
  value: ConfigurationValue | undefined,
  path: string,
  limit: number,
  allowEmpty: boolean,
): readonly string[] {
  const values = configurationArray(value, path, limit).map((entry, index) => identifier(entry, `${path}/${index}`));
  if (!allowEmpty && values.length === 0) throw new CockpitConfigurationError(path, "must not be empty");
  return values;
}

function stringMap(value: ConfigurationValue, path: string, arrays: boolean): ConfigurationObject {
  const row = configurationRecord(value, path);
  if (Object.keys(row).length > 128) throw new CockpitConfigurationError(path, "map is too large");
  const output: Record<string, ConfigurationValue> = {};
  for (const [key, entry] of Object.entries(row).sort(([left], [right]) => compareUtf8(left, right))) {
    identifier(key, `${path}/${key}`);
    output[key] = arrays
      ? identifierArray(entry, `${path}/${key}`, 32, false)
      : identifier(entry, `${path}/${key}`);
  }
  return output;
}

function safeStringMap(value: ConfigurationValue, path: string): ConfigurationObject {
  const row = configurationRecord(value, path);
  if (Object.keys(row).length > 32) throw new CockpitConfigurationError(path, "map is too large");
  const output: Record<string, ConfigurationValue> = {};
  for (const [key, entry] of Object.entries(row).sort(([left], [right]) => compareUtf8(left, right))) {
    identifier(key, `${path}/${key}`);
    output[key] = safeText(entry, `${path}/${key}`, 32);
  }
  return output;
}

function glyphMap(value: ConfigurationValue, path: string): ConfigurationObject {
  const row = configurationRecord(value, path);
  rejectUnknownKeys(row, path, ["done", "active", "pending"]);
  const output: Record<string, ConfigurationValue> = {};
  for (const key of ["done", "active", "pending"] as const) {
    const glyph = safeText(row[key], `${path}/${key}`, 4);
    if (Array.from(glyph).length !== 1) throw new CockpitConfigurationError(`${path}/${key}`, "must contain one visible glyph");
    output[key] = glyph;
  }
  return output;
}

function safeText(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > maximum) {
    throw new CockpitConfigurationError(path, `expected 1-${maximum} characters`);
  }
  if (/\p{Control}/u.test(value)) throw new CockpitConfigurationError(path, "control characters are not allowed");
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new CockpitConfigurationError(path, "expected a boolean");
  return value;
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new CockpitConfigurationError(path, `expected an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function configurationRecord(value: ConfigurationValue | undefined, path: string): ConfigurationObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CockpitConfigurationError(path, "expected an object");
  }
  return value as ConfigurationObject;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CockpitConfigurationError(path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new CockpitConfigurationError(path, "expected a plain object");
  return value as Record<string, unknown>;
}

function exactConfigurationRecord(
  value: ConfigurationValue | undefined,
  path: string,
  allowed: readonly string[],
): ConfigurationObject {
  const row = configurationRecord(value, path);
  rejectUnknownKeys(row, path, allowed);
  for (const required of ["id", "title", "kind", "source"]) {
    if (allowed.includes(required) && row[required] === undefined) throw new CockpitConfigurationError(`${path}/${required}`, "is required");
  }
  return row;
}

function exactRecord(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  const row = record(value, path);
  exactKeys(row, path, allowed);
  return row;
}

function exactKeys(row: Readonly<Record<string, unknown>>, path: string, allowed: readonly string[]): void {
  rejectUnknownKeys(row, path, allowed);
  for (const key of allowed) if (!(key in row)) throw new CockpitConfigurationError(`${path}/${key}`, "is required");
}

function rejectUnknownKeys(row: Readonly<Record<string, unknown>>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(row)) {
    if (!allowed.includes(key)) throw new CockpitConfigurationError(`${path}/${key}`, "unknown field is not consumed");
  }
}

function configurationArray(value: ConfigurationValue | undefined, path: string, limit: number): readonly ConfigurationValue[] {
  if (!Array.isArray(value) || value.length > limit) throw new CockpitConfigurationError(path, `expected an array with at most ${limit} items`);
  return value;
}

function boundedArray(value: unknown, path: string, limit: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new CockpitConfigurationError(path, `expected an array with at most ${limit} items`);
  return value;
}

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  const sorted = [...expected].sort(compareUtf8);
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function ensureUnique(values: readonly string[], path: string, label: string): void {
  if (new Set(values).size !== values.length) throw new CockpitConfigurationError(path, `contains a duplicate ${label}`);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
