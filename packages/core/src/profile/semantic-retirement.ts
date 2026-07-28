import YAML, { type Document } from "yaml";
import { isNormalizedSafeRelativePath } from "../compiler/profile-package.js";
import { canonicalHash, compareUtf8, rawSha256, type Sha256Digest } from "../shared/canonical.js";
import { parseStrictYamlObject } from "../shared/yaml.js";

export const PROFILE_RETIREMENT_RESOURCE_PROTOCOL = "koni.profile-retirement.v1" as const;
export const PROFILE_RETIREMENT_PREVIEW_PROTOCOL = "koni.profile-retirement-preview.v1" as const;

const MAX_RESOURCE_BYTES = 256 * 1024;
const MAX_OPERATIONS = 256;
const MAX_SELECTORS = 16;
const MAX_POINTER_DEPTH = 32;
const MAX_COMPONENT_BYTES = 1_024;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ProfileRetirementSelector {
  readonly array_pointer: string;
  readonly key: string;
  readonly equals: string;
}

export interface ProfileRetirementOperation {
  readonly file: string;
  readonly selectors?: readonly ProfileRetirementSelector[];
  /** Empty only for a selected-item retirement; ordinary fields use a safe mapping pointer. */
  readonly pointer: string;
  readonly remove_selected_item?: true;
}

export interface ProfileRetirementResource {
  readonly protocol: typeof PROFILE_RETIREMENT_RESOURCE_PROTOCOL;
  readonly id: string;
  readonly operations: readonly ProfileRetirementOperation[];
}

export interface ProfileRetirementValuePreview {
  readonly present: boolean;
  readonly valueSha256: Sha256Digest | null;
  readonly value?: JsonValue;
}

export interface ProfileRetirementOperationPreview {
  readonly file: string;
  readonly selectors: readonly ProfileRetirementSelector[];
  readonly pointer: string;
  readonly source: ProfileRetirementValuePreview & { readonly present: true };
  readonly project: ProfileRetirementValuePreview;
  readonly target: { readonly present: false };
}

export interface ProfileRetirementArchivePreview {
  readonly file: string;
  readonly projectSha256: Sha256Digest;
  readonly sizeBytes: number;
}

export interface ProfileRetirementPreview {
  readonly protocol: typeof PROFILE_RETIREMENT_PREVIEW_PROTOCOL;
  readonly id: string;
  readonly sourceBundleSha256: Sha256Digest;
  readonly targetBundleSha256: Sha256Digest;
  readonly resourceSha256: Sha256Digest;
  readonly operations: readonly ProfileRetirementOperationPreview[];
  readonly archives: readonly ProfileRetirementArchivePreview[];
  readonly planSha256: Sha256Digest;
}

export interface ProfileRetirementPlan {
  readonly preview: ProfileRetirementPreview;
  /** Exact project documents before retirement, including documents whose field was already absent. */
  readonly archivedProjectFiles: ReadonlyMap<string, Uint8Array>;
  /** Only project documents whose semantic value changed. */
  readonly changedProjectFiles: ReadonlyMap<string, Uint8Array>;
}

export class ProfileRetirementError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ProfileRetirementError";
    this.code = code;
  }
}

/**
 * Parse the sole supported profile semantic-migration resource.
 *
 * Resources are JSON, not executable code or interpolation templates. Running the source through
 * both the JSON parser and Koni's strict YAML parser gives us JSON syntax plus duplicate-key,
 * alias, unsafe-key, depth, and scalar-budget rejection.
 */
export function parseProfileRetirementResource(
  bytes: Uint8Array,
  expectedId?: string,
): ProfileRetirementResource {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RESOURCE_BYTES) {
    throw new ProfileRetirementError(
      "retirement_resource_size",
      "retirement resource exceeds its byte budget",
    );
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProfileRetirementError(
      "retirement_resource_encoding",
      "retirement resource must be UTF-8 JSON",
    );
  }
  try {
    JSON.parse(source);
  } catch {
    throw new ProfileRetirementError(
      "retirement_resource_json",
      "retirement resource must use strict JSON syntax",
    );
  }
  const parsed = parseStrictYamlObject(source, {
    maxBytes: MAX_RESOURCE_BYTES,
    maxDepth: 48,
    maxNodes: 16_384,
    maxScalarBytes: 16 * 1024,
  });
  if (!parsed.ok) {
    throw new ProfileRetirementError(
      "retirement_resource_json",
      parsed.diagnostics
        .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
        .join("\n"),
    );
  }
  const root = parsed.value;
  rejectUnknown(root, ["protocol", "id", "operations"], "retirement resource");
  if (root.protocol !== PROFILE_RETIREMENT_RESOURCE_PROTOCOL) {
    throw new ProfileRetirementError(
      "retirement_resource_protocol",
      "retirement resource protocol is not supported",
    );
  }
  if (typeof root.id !== "string" || !isSafeId(root.id)) {
    throw new ProfileRetirementError(
      "retirement_resource_id",
      "retirement resource id is not safe",
    );
  }
  if (expectedId !== undefined && root.id !== expectedId) {
    throw new ProfileRetirementError(
      "retirement_resource_id",
      "retirement resource id does not match its manifest descriptor",
    );
  }
  if (
    !Array.isArray(root.operations) ||
    root.operations.length === 0 ||
    root.operations.length > MAX_OPERATIONS
  ) {
    throw new ProfileRetirementError(
      "retirement_operation_count",
      "retirement operations must be a bounded nonempty array",
    );
  }
  const operations = root.operations.map((value, index) => parseOperation(value, index));
  assertCanonicalOperations(operations);
  return {
    protocol: PROFILE_RETIREMENT_RESOURCE_PROTOCOL,
    id: root.id,
    operations,
  };
}

/** Reject two independently authenticated resources that try to retire the same semantic field. */
export function assertProfileRetirementResourcesNonOverlapping(
  resources: readonly ProfileRetirementResource[],
): void {
  const operations = resources.flatMap((resource) => resource.operations);
  for (let leftIndex = 0; leftIndex < operations.length; leftIndex += 1) {
    const left = operations[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < operations.length; rightIndex += 1) {
      const right = operations[rightIndex]!;
      if (left.file !== right.file || selectorIdentity(left) !== selectorIdentity(right)) continue;
      const leftPath = operationPointer(left);
      const rightPath = operationPointer(right);
      if (isPrefix(leftPath, rightPath) || isPrefix(rightPath, leftPath)) {
        throw new ProfileRetirementError(
          "retirement_operation_overlap",
          "profile retirement resources contain duplicate or overlapping operations",
        );
      }
    }
  }
}

/**
 * Produce a deterministic, no-I/O retirement plan and transformed project documents.
 * Source and target maps are authenticated package bytes supplied by the installer. Project bytes
 * are exact snapshots read before the lifecycle transaction. The target must already omit every
 * retired field, making the resource a bounded assertion about the new compiler contract rather
 * than a general mutation program.
 */
export function planProfileRetirement(
  input: Readonly<{
    resourceBytes: Uint8Array;
    expectedId: string;
    sourceBundleSha256: Sha256Digest;
    targetBundleSha256: Sha256Digest;
    sourceBaselineFiles: ReadonlyMap<string, Uint8Array>;
    projectFiles: ReadonlyMap<string, Uint8Array | undefined>;
    targetBaselineFiles: ReadonlyMap<string, Uint8Array>;
  }>,
): ProfileRetirementPlan {
  const resource = parseProfileRetirementResource(input.resourceBytes, input.expectedId);
  const sourceDocuments = new Map<string, ParsedDocument>();
  const targetDocuments = new Map<string, ParsedDocument>();
  const projectDocuments = new Map<string, ParsedDocument>();
  const archivedProjectFiles = new Map<string, Uint8Array>();
  const operationPreviews: ProfileRetirementOperationPreview[] = [];

  for (const operation of resource.operations) {
    const sourceBytes = requiredFile(
      input.sourceBaselineFiles,
      operation.file,
      "retirement_source_file",
    );
    const targetBytes = requiredFile(
      input.targetBaselineFiles,
      operation.file,
      "retirement_target_file",
    );
    const source = documentFor(sourceDocuments, operation.file, sourceBytes, "source");
    const target = documentFor(targetDocuments, operation.file, targetBytes, "target");
    const projectBytes = input.projectFiles.get(operation.file);
    const project =
      projectBytes === undefined
        ? undefined
        : documentFor(projectDocuments, operation.file, projectBytes, "project");
    if (projectBytes !== undefined && !archivedProjectFiles.has(operation.file)) {
      archivedProjectFiles.set(operation.file, Uint8Array.from(projectBytes));
    }

    const sourceValue = inspectOperation(source.value, operation, "source", true);
    if (!sourceValue.present) {
      throw new ProfileRetirementError(
        "retirement_source_absent",
        `retired field is absent from authenticated source baseline: ${operationIdentity(operation)}`,
      );
    }
    const targetValue = inspectOperation(
      target.value,
      operation,
      "target",
      operation.remove_selected_item !== true,
    );
    if (targetValue.present) {
      throw new ProfileRetirementError(
        "retirement_target_present",
        `retired field remains present in authenticated target baseline: ${operationIdentity(operation)}`,
      );
    }
    const projectValue =
      project === undefined
        ? absentValue()
        : inspectOperation(project.value, operation, "project", false);
    operationPreviews.push({
      file: operation.file,
      selectors: [...(operation.selectors ?? [])],
      pointer: operation.pointer,
      source: presentValue(sourceValue.value),
      project: projectValue.present ? presentValue(projectValue.value) : absentValue(),
      target: { present: false },
    });
  }

  const changedProjectFiles = new Map<string, Uint8Array>();
  for (const [file, parsed] of projectDocuments) {
    const operations = resource.operations.filter((operation) => operation.file === file);
    let changed = false;
    for (const operation of operations) {
      const selected = selectContainer(parsed.value, operation, "project", false);
      if (selected === undefined) continue;
      const pointer = operationPointer(operation);
      const inspected =
        operation.remove_selected_item === true
          ? { present: true as const, value: structuredClone(selected.value) as JsonValue }
          : valueAt(selected.value, pointer);
      if (!inspected.present) continue;
      const mutationPath =
        operation.remove_selected_item === true ? selected.path : [...selected.path, ...pointer];
      parsed.document.deleteIn(mutationPath);
      changed = true;
      // Keep the semantic projection synchronized for a later non-overlapping operation.
      if (operation.remove_selected_item === true) deleteAtPath(parsed.value, selected.path);
      else deleteAt(selected.value, pointer);
    }
    if (!changed) continue;
    const transformed = Buffer.from(parsed.document.toString(), "utf8");
    const verified = parseMutableYamlDocument(transformed, `transformed project ${file}`);
    for (const operation of operations) {
      const value = inspectOperation(verified.value, operation, "transformed project", false);
      if (value.present) {
        throw new ProfileRetirementError(
          "retirement_transform_failed",
          `retired field survived transform: ${operationIdentity(operation)}`,
        );
      }
    }
    changedProjectFiles.set(file, transformed);
  }

  const archives = [...archivedProjectFiles]
    .map(([file, bytes]) => ({
      file,
      projectSha256: rawSha256(bytes),
      sizeBytes: bytes.byteLength,
    }))
    .sort((left, right) => compareUtf8(left.file, right.file));
  const previewMaterial = {
    protocol: PROFILE_RETIREMENT_PREVIEW_PROTOCOL,
    id: resource.id,
    sourceBundleSha256: input.sourceBundleSha256,
    targetBundleSha256: input.targetBundleSha256,
    resourceSha256: rawSha256(input.resourceBytes),
    operations: operationPreviews,
    archives,
  };
  return {
    preview: { ...previewMaterial, planSha256: canonicalHash(previewMaterial) },
    archivedProjectFiles,
    changedProjectFiles,
  };
}

interface ParsedDocument {
  readonly document: Document.Parsed;
  readonly value: Record<string, JsonValue>;
}

function parseOperation(value: unknown, index: number): ProfileRetirementOperation {
  if (!isRecord(value)) {
    throw new ProfileRetirementError(
      "retirement_operation",
      `retirement operation ${index} must be an object`,
    );
  }
  rejectUnknown(
    value,
    ["file", "selectors", "pointer", "remove_selected_item"],
    `retirement operation ${index}`,
  );
  if (
    typeof value.file !== "string" ||
    !isNormalizedSafeRelativePath(value.file) ||
    !/\.ya?ml$/u.test(value.file) ||
    value.file.startsWith(".managed/")
  ) {
    throw new ProfileRetirementError(
      "retirement_file",
      `retirement operation ${index} names an unsafe YAML file`,
    );
  }
  const removesSelectedItem = value.remove_selected_item === true;
  if (value.remove_selected_item !== undefined && !removesSelectedItem) {
    throw new ProfileRetirementError(
      "retirement_selected_item",
      `retirement operation ${index} has an invalid selected-item flag`,
    );
  }
  const pointer =
    typeof value.pointer === "string" ? decodeMappingPointer(value.pointer) : undefined;
  if (removesSelectedItem === (pointer !== undefined)) {
    throw new ProfileRetirementError(
      "retirement_pointer",
      `retirement operation ${index} must name exactly one mapping pointer or selected item`,
    );
  }
  let selectors: ProfileRetirementSelector[] | undefined;
  if (value.selectors !== undefined) {
    if (
      !Array.isArray(value.selectors) ||
      value.selectors.length === 0 ||
      value.selectors.length > MAX_SELECTORS
    ) {
      throw new ProfileRetirementError(
        "retirement_selectors",
        `retirement operation ${index} selectors are not bounded`,
      );
    }
    selectors = value.selectors.map((selector, selectorIndex) =>
      parseSelector(selector, index, selectorIndex),
    );
  }
  if (removesSelectedItem && selectors === undefined) {
    throw new ProfileRetirementError(
      "retirement_selected_item",
      `retirement operation ${index} cannot remove the root document`,
    );
  }
  return {
    file: value.file,
    ...(selectors === undefined ? {} : { selectors }),
    pointer: removesSelectedItem ? "" : (value.pointer as string),
    ...(removesSelectedItem ? { remove_selected_item: true as const } : {}),
  };
}

function parseSelector(
  value: unknown,
  operationIndex: number,
  selectorIndex: number,
): ProfileRetirementSelector {
  if (!isRecord(value)) {
    throw new ProfileRetirementError(
      "retirement_selector",
      `selector ${operationIndex}.${selectorIndex} must be an object`,
    );
  }
  rejectUnknown(
    value,
    ["array_pointer", "key", "equals"],
    `selector ${operationIndex}.${selectorIndex}`,
  );
  if (
    typeof value.array_pointer !== "string" ||
    decodeMappingPointer(value.array_pointer) === undefined
  ) {
    throw new ProfileRetirementError(
      "retirement_selector_pointer",
      `selector ${operationIndex}.${selectorIndex} has an invalid array pointer`,
    );
  }
  if (typeof value.key !== "string" || !isSafeMappingComponent(value.key)) {
    throw new ProfileRetirementError(
      "retirement_selector_key",
      `selector ${operationIndex}.${selectorIndex} has an invalid key`,
    );
  }
  if (
    typeof value.equals !== "string" ||
    value.equals.length === 0 ||
    Buffer.byteLength(value.equals, "utf8") > MAX_COMPONENT_BYTES ||
    containsControl(value.equals)
  ) {
    throw new ProfileRetirementError(
      "retirement_selector_value",
      `selector ${operationIndex}.${selectorIndex} has an invalid value`,
    );
  }
  return { array_pointer: value.array_pointer, key: value.key, equals: value.equals };
}

function assertCanonicalOperations(operations: readonly ProfileRetirementOperation[]): void {
  for (let index = 1; index < operations.length; index += 1) {
    const previous = operations[index - 1]!;
    const current = operations[index]!;
    const order = compareUtf8(operationIdentity(previous), operationIdentity(current));
    if (order >= 0) {
      throw new ProfileRetirementError(
        order === 0 ? "retirement_operation_duplicate" : "retirement_operation_order",
        "retirement operations must be unique and sorted by file, selectors, and pointer",
      );
    }
  }
  for (let leftIndex = 0; leftIndex < operations.length; leftIndex += 1) {
    const left = operations[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < operations.length; rightIndex += 1) {
      const right = operations[rightIndex]!;
      if (left.file !== right.file || selectorIdentity(left) !== selectorIdentity(right)) continue;
      const leftPath = operationPointer(left);
      const rightPath = operationPointer(right);
      if (isPrefix(leftPath, rightPath) || isPrefix(rightPath, leftPath)) {
        throw new ProfileRetirementError(
          "retirement_operation_overlap",
          "retirement operations must not overlap",
        );
      }
    }
  }
}

function documentFor(
  cache: Map<string, ParsedDocument>,
  file: string,
  bytes: Uint8Array,
  label: string,
): ParsedDocument {
  const existing = cache.get(file);
  if (existing !== undefined) return existing;
  const parsed = parseMutableYamlDocument(bytes, `${label} ${file}`);
  cache.set(file, parsed);
  return parsed;
}

function parseMutableYamlDocument(bytes: Uint8Array, label: string): ParsedDocument {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProfileRetirementError("retirement_yaml_encoding", `${label} is not UTF-8 YAML`);
  }
  const strict = parseStrictYamlObject(source);
  if (!strict.ok) {
    throw new ProfileRetirementError(
      "retirement_yaml_invalid",
      `${label} is not safe YAML: ${strict.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`,
    );
  }
  const document = YAML.parseDocument(source, {
    merge: false,
    prettyErrors: false,
    schema: "core",
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
  }) as Document.Parsed;
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new ProfileRetirementError("retirement_yaml_invalid", `${label} is not safe YAML`);
  }
  return { document, value: strict.value as Record<string, JsonValue> };
}

function inspectOperation(
  root: Record<string, JsonValue>,
  operation: ProfileRetirementOperation,
  label: string,
  requireSelectors: boolean,
): { present: true; value: JsonValue } | { present: false } {
  const selected = selectContainer(root, operation, label, requireSelectors);
  if (selected === undefined) return { present: false };
  if (operation.remove_selected_item === true) {
    return { present: true, value: structuredClone(selected.value) as JsonValue };
  }
  return valueAt(selected.value, operationPointer(operation));
}

function selectContainer(
  root: Record<string, JsonValue>,
  operation: ProfileRetirementOperation,
  label: string,
  requireSelectors: boolean,
): { value: Record<string, JsonValue>; path: Array<string | number> } | undefined {
  let value = root;
  const path: Array<string | number> = [];
  for (const selector of operation.selectors ?? []) {
    const arrayPath = decodeMappingPointer(selector.array_pointer)!;
    const located = valueAt(value, arrayPath);
    if (!located.present || !Array.isArray(located.value)) {
      if (!requireSelectors) return undefined;
      throw new ProfileRetirementError(
        "retirement_selector_absent",
        `${label} selector array is absent: ${operation.file}${selector.array_pointer}`,
      );
    }
    const matches: Array<{ index: number; value: Record<string, JsonValue> }> = [];
    for (const [index, item] of located.value.entries()) {
      if (isRecord(item) && item[selector.key] === selector.equals) {
        matches.push({ index, value: item });
      }
    }
    if (matches.length !== 1) {
      if (matches.length === 0 && !requireSelectors) return undefined;
      throw new ProfileRetirementError(
        matches.length === 0 ? "retirement_selector_absent" : "retirement_selector_ambiguous",
        `${label} selector must match exactly one mapping: ${selector.key}=${selector.equals}`,
      );
    }
    const match = matches[0]!;
    path.push(...arrayPath, match.index);
    value = match.value;
  }
  return { value, path };
}

function valueAt(
  root: Record<string, JsonValue>,
  components: readonly string[],
): { present: true; value: JsonValue } | { present: false } {
  let value: JsonValue = root;
  for (const component of components) {
    if (!isRecord(value) || !Object.hasOwn(value, component)) return { present: false };
    value = value[component] as JsonValue;
  }
  return { present: true, value: structuredClone(value) };
}

function deleteAt(root: Record<string, JsonValue>, components: readonly string[]): void {
  let value = root;
  for (const component of components.slice(0, -1)) {
    const next = value[component];
    if (!isRecord(next)) return;
    value = next;
  }
  delete value[components.at(-1)!];
}

function deleteAtPath(
  root: Record<string, JsonValue>,
  components: readonly (string | number)[],
): void {
  let value: JsonValue = root;
  for (const component of components.slice(0, -1)) {
    if (typeof component === "number") {
      if (!Array.isArray(value)) return;
      value = value[component] as JsonValue;
    } else {
      if (!isRecord(value)) return;
      value = value[component] as JsonValue;
    }
  }
  const final = components.at(-1);
  if (typeof final === "number" && Array.isArray(value)) value.splice(final, 1);
  else if (typeof final === "string" && isRecord(value)) delete value[final];
}

function presentValue(value: JsonValue): ProfileRetirementValuePreview & { present: true } {
  return { present: true, value: structuredClone(value), valueSha256: canonicalHash(value) };
}

function absentValue(): ProfileRetirementValuePreview & { present: false } {
  return { present: false, valueSha256: null };
}

function requiredFile(
  files: ReadonlyMap<string, Uint8Array>,
  relative: string,
  code: string,
): Uint8Array {
  const bytes = files.get(relative);
  if (bytes === undefined)
    throw new ProfileRetirementError(code, `retirement file is absent: ${relative}`);
  return bytes;
}

function decodeMappingPointer(pointer: string): string[] | undefined {
  if (
    !pointer.startsWith("/") ||
    pointer.length === 1 ||
    Buffer.byteLength(pointer, "utf8") > 4_096
  )
    return undefined;
  const tokens = pointer.slice(1).split("/");
  if (tokens.length === 0 || tokens.length > MAX_POINTER_DEPTH) return undefined;
  const components: string[] = [];
  for (const token of tokens) {
    if (token.length === 0 || /~(?:[^01]|$)/u.test(token)) return undefined;
    const decoded = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isSafeMappingComponent(decoded)) return undefined;
    components.push(decoded);
  }
  return components;
}

function isSafeMappingComponent(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "-" &&
    !/^\d+$/u.test(value) &&
    value !== "__proto__" &&
    value !== "prototype" &&
    value !== "constructor" &&
    Buffer.byteLength(value, "utf8") <= MAX_COMPONENT_BYTES &&
    !containsControl(value)
  );
}

function operationIdentity(operation: ProfileRetirementOperation): string {
  const target =
    operation.remove_selected_item === true ? "\u0003selected-item" : operation.pointer;
  return `${operation.file}\u0000${selectorIdentity(operation)}\u0000${target}`;
}

function operationPointer(operation: ProfileRetirementOperation): string[] {
  return operation.remove_selected_item === true ? [] : decodeMappingPointer(operation.pointer)!;
}

function selectorIdentity(operation: ProfileRetirementOperation): string {
  return (operation.selectors ?? [])
    .map((selector) => `${selector.array_pointer}\u0001${selector.key}\u0001${selector.equals}`)
    .join("\u0002");
}

function isPrefix(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length <= right.length && left.every((component, index) => right[index] === component)
  );
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ProfileRetirementError(
      "retirement_unknown_field",
      `${label} has unknown fields: ${unknown.join(", ")}`,
    );
  }
}

function isSafeId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value);
}

function containsControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
