import YAML, { type Document } from "yaml";
import { canonicalEncode, compareUtf8 } from "../shared/canonical.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type ParsedYaml = { document: Document.Parsed; value: JsonValue };
type Path = readonly string[];

const ROOT_CONFLICT = "/";
const MAX_CONFLICT_PATHS = 4_096;
const MAX_CONFLICT_PATH_BYTES = 4_096;

export interface YamlThreeWayMergeResult {
  /** Project-authored formatting/comments with every non-conflicting upstream change applied. */
  readonly bytes: Uint8Array;
  /** Sorted JSON-pointer-like paths. `/` denotes a whole-document conflict. */
  readonly conflictPaths: readonly string[];
}

interface MergeOperation {
  readonly kind: "set" | "delete";
  readonly path: Path;
  readonly value?: JsonValue;
}

/**
 * Merge one YAML configuration document as old-baseline / project / new-baseline.
 *
 * Maps are merged recursively. Lists and scalars are atomic values. Project-only edits remain,
 * upstream-only edits are applied, identical edits coalesce, and divergent edits remain at the
 * project value with an explicit field path. Returning `undefined` means the input is not one
 * safe, ordinary YAML value and the caller must retain its existing whole-file conflict path.
 */
export function threeWayMergeYaml(
  baseBytes: Uint8Array,
  projectBytes: Uint8Array,
  upstreamBytes: Uint8Array,
): YamlThreeWayMergeResult | undefined {
  const base = parseYaml(baseBytes);
  const project = parseYaml(projectBytes);
  const upstream = parseYaml(upstreamBytes);
  if (base === undefined || project === undefined || upstream === undefined) return undefined;

  const operations: MergeOperation[] = [];
  const conflicts: string[] = [];
  mergeValue(base.value, project.value, upstream.value, [], operations, conflicts);
  const conflictPaths = canonicalConflictPaths(conflicts);
  if (conflictPaths === undefined) return undefined;
  if (operations.length === 0) {
    return {
      bytes: Uint8Array.from(projectBytes),
      conflictPaths,
    };
  }

  for (const operation of operations) applyOperation(project.document, operation);
  const source = project.document.toString();
  // Treat serialization as untrusted. A formatter/library regression must not publish an invalid
  // YAML document merely because the three semantic inputs were valid.
  if (parseYaml(Buffer.from(source, "utf8")) === undefined) return undefined;
  return {
    bytes: Buffer.from(source, "utf8"),
    conflictPaths,
  };
}

/**
 * Accept only the divergent upstream fields from a previously auto-merged project document.
 * Non-conflicting project values and comments remain intact. Historical whole-file conflicts do
 * not call this helper and retain the compatibility resolution behavior.
 */
export function acceptYamlConflictPaths(
  projectBytes: Uint8Array,
  upstreamBytes: Uint8Array,
  conflictPaths: readonly string[],
): Uint8Array | undefined {
  const project = parseYaml(projectBytes);
  const upstream = parseYaml(upstreamBytes);
  if (project === undefined || upstream === undefined) return undefined;
  if (!isValidYamlConflictPaths(conflictPaths) || conflictPaths.includes(ROOT_CONFLICT))
    return undefined;

  for (const pointer of conflictPaths) {
    const path = decodePointer(pointer);
    if (path === undefined) return undefined;
    const upstreamValue = valueAt(upstream.value, path);
    if (upstreamValue.found) {
      applyOperation(project.document, { kind: "set", path, value: upstreamValue.value });
    } else {
      applyOperation(project.document, { kind: "delete", path });
    }
  }
  const source = project.document.toString();
  if (parseYaml(Buffer.from(source, "utf8")) === undefined) return undefined;
  return Buffer.from(source, "utf8");
}

export function isValidYamlConflictPaths(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CONFLICT_PATHS)
    return false;
  if (value.includes(ROOT_CONFLICT) && value.length !== 1) return false;
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      Buffer.byteLength(item, "utf8") > MAX_CONFLICT_PATH_BYTES ||
      decodePointer(item) === undefined ||
      seen.has(item) ||
      (index > 0 && compareUtf8(value[index - 1] as string, item) >= 0)
    )
      return false;
    seen.add(item);
  }
  return true;
}

function mergeValue(
  base: JsonValue,
  project: JsonValue,
  upstream: JsonValue,
  path: Path,
  operations: MergeOperation[],
  conflicts: string[],
): void {
  if (equal(project, upstream) || equal(upstream, base)) return;
  if (equal(project, base)) {
    operations.push({ kind: "set", path, value: structuredClone(upstream) });
    return;
  }
  if (isObject(base) && isObject(project) && isObject(upstream)) {
    mergeObjects(base, project, upstream, path, operations, conflicts);
    return;
  }
  conflicts.push(encodePointer(path));
}

function mergeObjects(
  base: Record<string, JsonValue>,
  project: Record<string, JsonValue>,
  upstream: Record<string, JsonValue>,
  path: Path,
  operations: MergeOperation[],
  conflicts: string[],
): void {
  const keys = orderedUnion(Object.keys(base), Object.keys(project), Object.keys(upstream));
  for (const key of keys) {
    const childPath = [...path, key];
    const baseHas = Object.hasOwn(base, key);
    const projectHas = Object.hasOwn(project, key);
    const upstreamHas = Object.hasOwn(upstream, key);
    if (!baseHas) {
      if (!projectHas && upstreamHas) {
        operations.push({ kind: "set", path: childPath, value: structuredClone(upstream[key]!) });
      } else if (projectHas && upstreamHas && !equal(project[key]!, upstream[key]!)) {
        if (isObject(project[key]!) && isObject(upstream[key]!)) {
          mergeObjects({}, project[key], upstream[key], childPath, operations, conflicts);
        } else {
          conflicts.push(encodePointer(childPath));
        }
      }
      continue;
    }
    if (!projectHas) {
      if (upstreamHas && !equal(upstream[key]!, base[key]!))
        conflicts.push(encodePointer(childPath));
      continue;
    }
    if (!upstreamHas) {
      if (equal(project[key]!, base[key]!)) operations.push({ kind: "delete", path: childPath });
      else conflicts.push(encodePointer(childPath));
      continue;
    }
    mergeValue(base[key]!, project[key]!, upstream[key]!, childPath, operations, conflicts);
  }
}

function applyOperation(document: Document.Parsed, operation: MergeOperation): void {
  if (operation.path.length === 0) {
    if (operation.kind === "delete") document.contents = null;
    else
      document.contents = document.createNode(
        structuredClone(operation.value),
      ) as Document.Parsed["contents"];
    return;
  }
  if (operation.kind === "delete") document.deleteIn([...operation.path]);
  else document.setIn([...operation.path], structuredClone(operation.value));
}

function parseYaml(bytes: Uint8Array): ParsedYaml | undefined {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  let documents: Document.Parsed[];
  try {
    documents = YAML.parseAllDocuments(source, {
      schema: "core",
      strict: true,
      uniqueKeys: true,
    }) as Document.Parsed[];
  } catch {
    return undefined;
  }
  if (documents.length !== 1 || documents[0]!.errors.length > 0) return undefined;
  let value: unknown;
  try {
    value = documents[0]!.toJS({ maxAliasCount: 0 });
  } catch {
    return undefined;
  }
  if (!isJsonValue(value)) return undefined;
  return { document: documents[0]!, value };
}

function valueAt(
  root: JsonValue,
  path: Path,
): { found: true; value: JsonValue } | { found: false } {
  let value: JsonValue = root;
  for (const component of path) {
    if (!isObject(value) || !Object.hasOwn(value, component)) return { found: false };
    value = value[component]!;
  }
  return { found: true, value: structuredClone(value) };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isObject(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(isJsonValue);
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function equal(left: JsonValue, right: JsonValue): boolean {
  return canonicalEncode(left) === canonicalEncode(right);
}

function orderedUnion(...groups: readonly string[][]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const group of groups) {
    for (const value of group)
      if (!seen.has(value)) {
        seen.add(value);
        output.push(value);
      }
  }
  return output;
}

function normalizeConflictPaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort(compareUtf8);
}

function canonicalConflictPaths(paths: readonly string[]): string[] | undefined {
  const normalized = normalizeConflictPaths(paths);
  if (normalized.length === 0) return normalized;
  return isValidYamlConflictPaths(normalized) ? normalized : undefined;
}

function encodePointer(path: Path): string {
  if (path.length === 0) return ROOT_CONFLICT;
  return `/${path.map((component) => component.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function decodePointer(pointer: string): string[] | undefined {
  if (pointer === ROOT_CONFLICT) return [];
  if (!pointer.startsWith("/") || pointer.length === 1) return undefined;
  const output: string[] = [];
  for (const token of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/u.test(token)) return undefined;
    const decoded = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (decoded.length === 0) return undefined;
    output.push(decoded);
  }
  return output;
}
