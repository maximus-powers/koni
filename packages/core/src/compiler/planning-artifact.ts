import type { JsonValue } from "../authority/protocol.js";
import {
  canonicalHash,
  compareUtf8,
  isSha256Digest,
  type Sha256Digest,
} from "../shared/canonical.js";

export const PLAN_DOMAINS = ["architecture", "decisions", "risk", "verification"] as const;
export type PlanDomain = (typeof PLAN_DOMAINS)[number];

const MAX_PLAN_CHARS = 24_000;
const SAFE_LOCAL_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DEFAULT_PROTECTED_ROOT_FIELDS = new Set([
  "$root",
  "id",
  "key",
  "type",
  "status",
  "objective",
  "goal",
  "planning_context",
  "tickets",
  "receipts",
]);

export interface PlanReviewItem {
  title: string;
  description: string;
}

export interface PlanningGraphSeedNode {
  key: string;
  type: string;
  title: string;
  spec: Record<string, JsonValue>;
}

export interface PlanningGraphSeedEdge {
  source: string;
  relation: string;
  target: string;
}

export interface PlanningGraphSeed {
  rootSpec: Record<string, JsonValue>;
  nodes: PlanningGraphSeedNode[];
  edges: PlanningGraphSeedEdge[];
}

export interface PlanningArtifact {
  title?: string;
  full: Record<PlanDomain, string>;
  concise: Record<PlanDomain, PlanReviewItem[]>;
  graphSeed: PlanningGraphSeed;
}

export interface PlanningGraphSeedPatch {
  setRootSpec?: Record<string, JsonValue>;
  removeRootSpecFields?: string[];
  upsertNodes?: PlanningGraphSeedNode[];
  removeNodeKeys?: string[];
  addEdges?: PlanningGraphSeedEdge[];
  removeEdges?: PlanningGraphSeedEdge[];
}

export interface PlanningArtifactPatch {
  baseRevision: number;
  baseArtifactSha256: Sha256Digest;
  title?: string;
  full?: Partial<Record<PlanDomain, string>>;
  concise?: Partial<Record<PlanDomain, PlanReviewItem[]>>;
  graphSeed?: PlanningGraphSeedPatch;
}

export interface PlanningArtifactPatchOptions {
  baseRevision?: number;
  protectedRootSpecFields?: readonly string[];
}

export class PlanningArtifactValidationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlanningArtifactValidationError";
  }
}

export function parsePlanningArtifact(value: unknown): PlanningArtifact {
  const root = requiredRecord(value, "planning artifact");
  assertAllowedFields(root, ["full", "concise", "graphSeed", "title"], "planning artifact");
  for (const field of ["full", "concise", "graphSeed"] as const) {
    if (!Object.hasOwn(root, field)) fail("missing_field", `planning artifact is missing ${field}`);
  }
  const title =
    root.title === undefined
      ? undefined
      : boundedText(root.title, "plan title", 60).replace(/\s+/gu, " ").trim();
  if (title !== undefined && title.length < 3) {
    fail("plan_title", "plan title must be at least 3 characters");
  }
  const full = parsePlanningFullPlans(root.full, "full plans");
  const conciseRoot = requiredRecord(root.concise, "concise plans");
  assertExactFields(conciseRoot, PLAN_DOMAINS, "concise plans");
  const concise = Object.create(null) as Record<PlanDomain, PlanReviewItem[]>;
  for (const domain of PLAN_DOMAINS)
    concise[domain] = parseReviewItems(conciseRoot[domain], domain);
  return {
    ...(title === undefined ? {} : { title }),
    full,
    concise,
    graphSeed: parsePlanningGraphSeed(root.graphSeed),
  };
}

export function parsePlanningArtifactPatch(value: unknown): PlanningArtifactPatch {
  const root = requiredRecord(value, "planning artifact patch");
  assertAllowedFields(
    root,
    ["baseRevision", "baseArtifactSha256", "title", "full", "concise", "graphSeed"],
    "planning artifact patch",
  );
  if (!Number.isSafeInteger(root.baseRevision) || Number(root.baseRevision) < 0) {
    fail("patch_base_revision", "planning patch baseRevision must be a non-negative safe integer");
  }
  if (!isSha256Digest(root.baseArtifactSha256)) {
    fail("patch_base_hash", "planning patch baseArtifactSha256 is invalid");
  }
  const title =
    root.title === undefined
      ? undefined
      : boundedText(root.title, "planning patch title", 60).replace(/\s+/gu, " ").trim();
  if (title !== undefined && title.length < 3) {
    fail("patch_title", "planning patch title must be at least 3 characters");
  }
  const full = root.full === undefined ? undefined : parsePartialPlanTextRecord(root.full);
  const concise = root.concise === undefined ? undefined : parsePartialConcise(root.concise);
  const graphSeed =
    root.graphSeed === undefined ? undefined : parsePlanningGraphSeedPatch(root.graphSeed);
  if (
    title === undefined &&
    full === undefined &&
    concise === undefined &&
    graphSeed === undefined
  ) {
    fail("patch_empty", "planning patch must contain at least one bounded artifact change");
  }
  return {
    baseRevision: Number(root.baseRevision),
    baseArtifactSha256: root.baseArtifactSha256,
    ...(title === undefined ? {} : { title }),
    ...(full === undefined ? {} : { full }),
    ...(concise === undefined ? {} : { concise }),
    ...(graphSeed === undefined ? {} : { graphSeed }),
  };
}

export function applyPlanningArtifactPatch(
  baseValue: unknown,
  patchValue: unknown,
  options: Readonly<PlanningArtifactPatchOptions> = {},
): PlanningArtifact {
  const suppliedBaseSha256 = canonicalHash(baseValue);
  const base = parsePlanningArtifact(baseValue);
  const patch = parsePlanningArtifactPatch(patchValue);
  if (options.baseRevision !== undefined && patch.baseRevision !== options.baseRevision) {
    fail(
      "patch_base_revision",
      `planning patch names base revision ${patch.baseRevision}, expected ${options.baseRevision}`,
    );
  }
  if (suppliedBaseSha256 !== patch.baseArtifactSha256) {
    fail(
      "patch_base_hash",
      "planning patch base artifact hash does not match the validated artifact",
    );
  }

  const revised = structuredClone(base);
  if (patch.title !== undefined) revised.title = patch.title;
  for (const domain of PLAN_DOMAINS) {
    if (patch.full?.[domain] !== undefined) revised.full[domain] = patch.full[domain];
    if (patch.concise?.[domain] !== undefined) {
      revised.concise[domain] = structuredClone(patch.concise[domain]);
    }
  }
  if (patch.graphSeed !== undefined) {
    revised.graphSeed = applyPlanningGraphSeedPatch(revised.graphSeed, patch.graphSeed, options);
  }
  return parsePlanningArtifact(revised);
}

export function canonicalizePlanningGraphSeed(seed: PlanningGraphSeed): PlanningGraphSeed {
  return {
    rootSpec: canonicalizeJsonRecord(seed.rootSpec),
    nodes: seed.nodes
      .map((node) => ({ ...structuredClone(node), spec: canonicalizeJsonRecord(node.spec) }))
      .sort((left, right) => compareUtf8(left.key, right.key)),
    edges: seed.edges.map((edge) => ({ ...edge })).sort(compareEdges),
  };
}

export function parsePlanningGraphSeed(value: unknown): PlanningGraphSeed {
  const root = requiredRecord(value, "graph seed");
  assertExactFields(root, ["rootSpec", "nodes", "edges"], "graph seed");
  const rootSpec = parseJsonRecord(root.rootSpec, "graph seed rootSpec");
  if (!Array.isArray(root.nodes) || root.nodes.length > 1_024) {
    fail("graph_seed_nodes", "graph seed nodes are invalid or oversized");
  }
  if (!Array.isArray(root.edges) || root.edges.length > 4_096) {
    fail("graph_seed_edges", "graph seed edges are invalid or oversized");
  }
  const keys = new Set<string>();
  const nodes = root.nodes.map((node, index) => parseNode(node, index, keys));
  const edges = parseEdges(root.edges, keys, "graph seed edge");
  if (Object.keys(rootSpec).length === 0 && nodes.length === 0) {
    fail("graph_seed_empty", "graph seed must enrich the root or add at least one typed node");
  }
  ensureConnected(keys, edges);
  return canonicalizePlanningGraphSeed({ rootSpec, nodes, edges });
}

function applyPlanningGraphSeedPatch(
  base: PlanningGraphSeed,
  patch: PlanningGraphSeedPatch,
  options: Readonly<PlanningArtifactPatchOptions>,
): PlanningGraphSeed {
  const protectedFields = new Set([
    ...DEFAULT_PROTECTED_ROOT_FIELDS,
    ...(options.protectedRootSpecFields ?? []),
  ]);
  const rootSpec = structuredClone(base.rootSpec);
  for (const field of patch.removeRootSpecFields ?? []) {
    if (protectedFields.has(field))
      fail("patch_protected_root", `cannot remove protected root field ${field}`);
    if (!Object.hasOwn(rootSpec, field)) {
      fail("patch_root_field", `cannot remove unknown root field ${field}`);
    }
    delete rootSpec[field];
  }
  for (const [field, value] of Object.entries(patch.setRootSpec ?? {})) {
    if (protectedFields.has(field))
      fail("patch_protected_root", `cannot replace protected root field ${field}`);
    rootSpec[field] = structuredClone(value);
  }

  const nodes = new Map(base.nodes.map((node) => [node.key, structuredClone(node)]));
  for (const node of patch.upsertNodes ?? []) nodes.set(node.key, structuredClone(node));
  for (const key of patch.removeNodeKeys ?? []) {
    if (!nodes.delete(key)) fail("patch_node_remove", `cannot remove unknown graph node ${key}`);
  }

  const edges = new Map(base.edges.map((edge) => [edgeIdentity(edge), { ...edge }]));
  for (const edge of patch.removeEdges ?? []) {
    if (!edges.delete(edgeIdentity(edge))) {
      fail("patch_edge_remove", `cannot remove unknown graph edge ${formatEdge(edge)}`);
    }
  }
  for (const edge of patch.addEdges ?? []) {
    const identity = edgeIdentity(edge);
    if (edges.has(identity))
      fail("patch_edge_add", `cannot add duplicate graph edge ${formatEdge(edge)}`);
    edges.set(identity, { ...edge });
  }
  return parsePlanningGraphSeed({
    rootSpec,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  });
}

function parsePlanningGraphSeedPatch(value: unknown): PlanningGraphSeedPatch {
  const root = requiredRecord(value, "graph seed patch");
  assertAllowedFields(
    root,
    [
      "setRootSpec",
      "removeRootSpecFields",
      "upsertNodes",
      "removeNodeKeys",
      "addEdges",
      "removeEdges",
    ],
    "graph seed patch",
  );
  const setRootSpec =
    root.setRootSpec === undefined
      ? undefined
      : parseJsonRecord(root.setRootSpec, "graph seed patch setRootSpec");
  const removeRootSpecFields = parseUniqueStrings(
    root.removeRootSpecFields,
    "graph seed patch removeRootSpecFields",
  );
  const removeNodeKeys = parseUniqueStrings(root.removeNodeKeys, "graph seed patch removeNodeKeys");
  for (const key of removeNodeKeys ?? []) {
    if (!SAFE_LOCAL_KEY.test(key) || key === "$root") {
      fail("patch_node_key", `invalid graph seed node removal key ${key}`);
    }
  }
  const upsertNodes = parsePatchNodes(root.upsertNodes);
  const addEdges = parsePatchEdges(root.addEdges, "graph seed patch addEdges");
  const removeEdges = parsePatchEdges(root.removeEdges, "graph seed patch removeEdges");
  assertNoOverlap(
    new Set(Object.keys(setRootSpec ?? {})),
    new Set(removeRootSpecFields ?? []),
    "graph seed patch sets and removes the same root field",
  );
  assertNoOverlap(
    new Set((upsertNodes ?? []).map((node) => node.key)),
    new Set(removeNodeKeys ?? []),
    "graph seed patch upserts and removes the same node",
  );
  assertNoOverlap(
    new Set((addEdges ?? []).map(edgeIdentity)),
    new Set((removeEdges ?? []).map(edgeIdentity)),
    "graph seed patch adds and removes the same edge",
  );
  const parsed = {
    ...(setRootSpec === undefined ? {} : { setRootSpec }),
    ...(removeRootSpecFields === undefined ? {} : { removeRootSpecFields }),
    ...(upsertNodes === undefined ? {} : { upsertNodes }),
    ...(removeNodeKeys === undefined ? {} : { removeNodeKeys }),
    ...(addEdges === undefined ? {} : { addEdges }),
    ...(removeEdges === undefined ? {} : { removeEdges }),
  };
  if (Object.keys(parsed).length === 0) fail("patch_graph_empty", "graph seed patch is empty");
  return parsed;
}

function parsePartialPlanTextRecord(value: unknown): Partial<Record<PlanDomain, string>> {
  const root = requiredRecord(value, "planning patch full plans");
  assertAllowedFields(root, PLAN_DOMAINS, "planning patch full plans");
  if (Object.keys(root).length === 0)
    fail("patch_full_empty", "planning patch full plans are empty");
  const output: Partial<Record<PlanDomain, string>> = {};
  for (const domain of PLAN_DOMAINS) {
    if (root[domain] !== undefined)
      output[domain] = boundedText(root[domain], domain, MAX_PLAN_CHARS).trim();
  }
  return output;
}

function parsePartialConcise(value: unknown): Partial<Record<PlanDomain, PlanReviewItem[]>> {
  const root = requiredRecord(value, "planning patch concise plans");
  assertAllowedFields(root, PLAN_DOMAINS, "planning patch concise plans");
  if (Object.keys(root).length === 0)
    fail("patch_concise_empty", "planning patch concise plans are empty");
  const output: Partial<Record<PlanDomain, PlanReviewItem[]>> = {};
  for (const domain of PLAN_DOMAINS) {
    if (root[domain] !== undefined) output[domain] = parseReviewItems(root[domain], domain);
  }
  return output;
}

export function parsePlanningFullPlans(
  value: unknown,
  label = "full plans",
): Record<PlanDomain, string> {
  const root = requiredRecord(value, label);
  assertExactFields(root, PLAN_DOMAINS, label);
  const output = Object.create(null) as Record<PlanDomain, string>;
  for (const domain of PLAN_DOMAINS)
    output[domain] = boundedText(root[domain], `${label}.${domain}`, MAX_PLAN_CHARS).trim();
  return output;
}

function parseReviewItems(value: unknown, domain: PlanDomain): PlanReviewItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) {
    fail("plan_concise_items", `${domain} requires one to seven concise items`);
  }
  const titles = new Set<string>();
  return value.map((item, index) => {
    const record = requiredRecord(item, `${domain} concise item ${index}`);
    assertExactFields(record, ["title", "description"], `${domain} concise item ${index}`);
    const title = boundedText(record.title, `${domain} concise title`, 160).trim();
    const description = boundedText(
      record.description,
      `${domain} concise description`,
      1_200,
    ).trim();
    const identity = title.toLocaleLowerCase("en-US");
    if (titles.has(identity))
      fail("plan_concise_duplicate", `${domain} contains duplicate concise title ${title}`);
    titles.add(identity);
    return { title, description };
  });
}

function parsePatchNodes(value: unknown): PlanningGraphSeedNode[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_024) {
    fail("patch_nodes", "graph seed patch upsertNodes must contain one to 1024 nodes");
  }
  const keys = new Set<string>();
  return value.map((node, index) => parseNode(node, index, keys));
}

function parsePatchEdges(value: unknown, label: string): PlanningGraphSeedEdge[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 4_096) {
    fail("patch_edges", `${label} must contain one to 4096 edges`);
  }
  const identities = new Set<string>();
  return value.map((edge, index) => {
    const parsed = parseEdge(edge, `${label} ${index}`);
    const identity = edgeIdentity(parsed);
    if (identities.has(identity))
      fail("patch_edge_duplicate", `${label} contains a duplicate edge`);
    identities.add(identity);
    return parsed;
  });
}

function parseNode(value: unknown, index: number, keys: Set<string>): PlanningGraphSeedNode {
  const node = requiredRecord(value, `graph seed node ${index}`);
  assertExactFields(node, ["key", "type", "title", "spec"], `graph seed node ${index}`);
  const key = requiredText(node.key, "graph seed node key");
  if (!SAFE_LOCAL_KEY.test(key) || key === "$root" || keys.has(key)) {
    fail("graph_seed_key", `invalid or duplicate graph seed key ${key}`);
  }
  keys.add(key);
  return {
    key,
    type: requiredText(node.type, `graph seed node ${key} type`),
    title: boundedText(node.title, `graph seed node ${key} title`, 16_384),
    spec: parseJsonRecord(node.spec, `graph seed node ${key} spec`),
  };
}

function parseEdges(
  value: unknown[],
  keys: ReadonlySet<string>,
  label: string,
): PlanningGraphSeedEdge[] {
  const identities = new Set<string>();
  return value.map((edge, index) => {
    const parsed = parseEdge(edge, `${label} ${index}`);
    const unknown = [
      ...new Set([parsed.source, parsed.target].filter((key) => key !== "$root" && !keys.has(key))),
    ];
    if (unknown.length > 0) {
      fail(
        "graph_seed_edge_key",
        `${label} ${index} references unknown local ${unknown.length === 1 ? "key" : "keys"}: ${unknown.join(", ")}; use $root for the existing run objective`,
      );
    }
    const identity = edgeIdentity(parsed);
    if (identities.has(identity))
      fail("graph_seed_edge_duplicate", "graph seed contains a duplicate relationship");
    identities.add(identity);
    return parsed;
  });
}

function parseEdge(value: unknown, label: string): PlanningGraphSeedEdge {
  const edge = requiredRecord(value, label);
  assertExactFields(edge, ["source", "relation", "target"], label);
  const parsed = {
    source: requiredText(edge.source, `${label} source`),
    relation: requiredText(edge.relation, `${label} relation`),
    target: requiredText(edge.target, `${label} target`),
  };
  if (parsed.source === parsed.target)
    fail("graph_seed_self_edge", "graph seed edge may not self-reference");
  return parsed;
}

function ensureConnected(keys: ReadonlySet<string>, edges: readonly PlanningGraphSeedEdge[]): void {
  if (keys.size === 0) return;
  const reached = new Set(["$root"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (reached.has(edge.source) && !reached.has(edge.target)) {
        reached.add(edge.target);
        changed = true;
      }
      if (reached.has(edge.target) && !reached.has(edge.source)) {
        reached.add(edge.source);
        changed = true;
      }
    }
  }
  const disconnected = [...keys].filter((key) => !reached.has(key)).sort(compareUtf8);
  if (disconnected.length > 0)
    fail(
      "graph_seed_disconnected",
      `graph seed contains disconnected local keys: ${disconnected.join(", ")}`,
    );
}

function parseUniqueStrings(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 4_096) {
    fail("patch_string_list", `${label} must contain one to 4096 strings`);
  }
  const output = value.map((entry) => requiredText(entry, label));
  if (new Set(output).size !== output.length)
    fail("patch_duplicate", `${label} contains duplicates`);
  return output;
}

function assertNoOverlap(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
  message: string,
): void {
  if ([...left].some((value) => right.has(value))) fail("patch_conflict", message);
}

function canonicalizeJsonRecord(value: Record<string, JsonValue>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareUtf8)
      .map((key) => [key, canonicalizeJsonValue(value[key]!)]),
  );
}

function canonicalizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (isRecord(value)) return canonicalizeJsonRecord(value);
  return value;
}

function parseJsonRecord(value: unknown, label: string): Record<string, JsonValue> {
  const root = requiredRecord(value, label);
  return canonicalizeJsonRecord(
    Object.fromEntries(
      Object.entries(root).map(([key, item]) => [key, parseJsonValue(item, `${label}.${key}`)]),
    ),
  );
}

function parseJsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value))
    return value.map((item, index) => parseJsonValue(item, `${label}[${index}]`));
  if (isRecord(value)) return parseJsonRecord(value, label);
  fail("json_value", `${label} is not a JSON value`);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail("record", `${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    fail("text", `${label} must be nonempty text no longer than ${maximum} characters`);
  }
  return value;
}

function requiredText(value: unknown, label: string): string {
  return boundedText(value, label, 16_384).trim();
}

function assertAllowedFields(
  root: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const allowed = new Set(fields);
  const extra = Object.keys(root).filter((field) => !allowed.has(field));
  if (extra.length > 0) fail("unexpected_field", `${label} contains unexpected field ${extra[0]}`);
}

function assertExactFields(
  root: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  assertAllowedFields(root, fields, label);
  const missing = fields.filter((field) => !Object.hasOwn(root, field));
  if (missing.length > 0) fail("missing_field", `${label} is missing ${missing[0]}`);
}

function edgeIdentity(edge: PlanningGraphSeedEdge): string {
  return `${edge.source}\0${edge.relation}\0${edge.target}`;
}

function formatEdge(edge: PlanningGraphSeedEdge): string {
  return `${edge.source} -[${edge.relation}]-> ${edge.target}`;
}

function compareEdges(left: PlanningGraphSeedEdge, right: PlanningGraphSeedEdge): number {
  return (
    compareUtf8(left.source, right.source) ||
    compareUtf8(left.relation, right.relation) ||
    compareUtf8(left.target, right.target)
  );
}

function fail(code: string, message: string): never {
  throw new PlanningArtifactValidationError(code, message);
}
