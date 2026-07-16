import { Buffer } from "node:buffer";
import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Node,
  type Pair,
} from "yaml";
import {
  DiagnosticBag,
  pointer,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from "./diagnostics.js";

export interface StrictYamlLimits {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxScalarBytes: number;
}

export const DEFAULT_STRICT_YAML_LIMITS: StrictYamlLimits = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 100_000,
  maxScalarBytes: 1024 * 1024,
});

export function parseStrictYaml(
  source: string,
  limits: Partial<StrictYamlLimits> = {},
): ValidationResult<unknown> {
  const resolved = resolveLimits(limits);
  const bag = new DiagnosticBag();
  if (Buffer.byteLength(source, "utf8") > resolved.maxBytes) {
    bag.error("yaml.byte_limit", "", "YAML document exceeds the configured byte limit");
    return validationFailure(bag.sorted());
  }

  let documents;
  try {
    documents = parseAllDocuments(source, {
      merge: false,
      prettyErrors: false,
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
    });
  } catch {
    bag.error("yaml.syntax", "", "YAML document is invalid");
    return validationFailure(bag.sorted());
  }
  if (documents.length !== 1) {
    bag.error("yaml.document_count", "", "exactly one YAML document is required");
    return validationFailure(bag.sorted());
  }
  const document = documents[0];
  if (document === undefined) {
    bag.error("yaml.document_count", "", "exactly one YAML document is required");
    return validationFailure(bag.sorted());
  }
  for (const error of [...document.errors, ...document.warnings]) {
    const code = safeParserCode(error.code);
    const position = error.linePos?.[0];
    bag.error(
      `yaml.${code.toLowerCase()}`,
      "",
      `YAML document is invalid (${code})`,
      position === undefined ? undefined : { line: position.line, column: position.col },
    );
  }
  if (document.contents === null) {
    bag.error("yaml.empty", "", "YAML document must not be empty");
  } else {
    inspectNode(document.contents, "", 0, { count: 0 }, resolved, bag);
  }
  if (bag.hasErrors()) {
    return validationFailure(bag.sorted());
  }

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
    value = normalizeYamlValue(value, "", 0, { count: 0 }, resolved, bag);
  } catch {
    bag.error("yaml.conversion", "", "YAML document could not be converted safely");
  }
  if (bag.hasErrors()) {
    return validationFailure(bag.sorted());
  }
  return validationSuccess(value, bag.sorted());
}

export function parseStrictYamlObject(
  source: string,
  limits: Partial<StrictYamlLimits> = {},
): ValidationResult<Record<string, unknown>> {
  const parsed = parseStrictYaml(source, limits);
  if (!parsed.ok) {
    return parsed;
  }
  if (!isPlainRecord(parsed.value)) {
    const bag = new DiagnosticBag();
    bag.extend(parsed.diagnostics);
    bag.error("yaml.root_type", "", "YAML document root must be a mapping");
    return validationFailure(bag.sorted());
  }
  return validationSuccess(parsed.value, parsed.diagnostics);
}

function inspectNode(
  node: Node | Pair,
  path: string,
  depth: number,
  state: { count: number },
  limits: StrictYamlLimits,
  bag: DiagnosticBag,
): void {
  state.count += 1;
  if (state.count > limits.maxNodes) {
    bag.error("yaml.node_limit", path, "YAML document exceeds the configured node limit");
    return;
  }
  if (depth > limits.maxDepth) {
    bag.error("yaml.depth_limit", path, "YAML document exceeds the configured nesting limit");
    return;
  }
  if (isAlias(node)) {
    bag.error("yaml.alias", path, "YAML aliases are not permitted");
    return;
  }
  if ("anchor" in node && typeof node.anchor === "string") {
    bag.error("yaml.anchor", path, "YAML anchors are not permitted");
  }
  if ("tag" in node && typeof node.tag === "string") {
    bag.error("yaml.tag", path, "explicit YAML tags are not permitted");
  }
  if (isScalar(node)) {
    if (typeof node.value === "string" && Buffer.byteLength(node.value, "utf8") > limits.maxScalarBytes) {
      bag.error("yaml.scalar_limit", path, "YAML scalar exceeds the configured byte limit");
    }
    return;
  }
  if (isSeq(node)) {
    node.items.forEach((item, index) => {
      if (isInspectableNode(item)) {
        inspectNode(item, pointer(path, index), depth + 1, state, limits, bag);
      } else if (item !== null) {
        bag.error("yaml.unsupported_node", pointer(path, index), "YAML node is not supported");
      }
    });
    return;
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      inspectNode(pair, path, depth + 1, state, limits, bag);
    }
    return;
  }
  if (isPair(node)) {
    const key = node.key;
    if (!isScalar(key) || typeof key.value !== "string") {
      bag.error("yaml.mapping_key", path, "YAML mapping keys must be strings");
      return;
    }
    const keyIsSafe = safeKey(key.value);
    if (!keyIsSafe) {
      bag.error("yaml.unsafe_key", path, "YAML mapping contains an unsafe key");
    }
    const child = keyIsSafe ? pointer(path, key.value) : path;
    if (key.value === "<<") {
      bag.error("yaml.merge_key", path, "YAML merge keys are not permitted");
    }
    inspectNode(key, child, depth, state, limits, bag);
    if (isInspectableNode(node.value)) {
      inspectNode(node.value, child, depth, state, limits, bag);
    } else if (node.value !== null) {
      bag.error("yaml.unsupported_node", child, "YAML node is not supported");
    }
  }
}

function normalizeYamlValue(
  value: unknown,
  path: string,
  depth: number,
  state: { count: number },
  limits: StrictYamlLimits,
  bag: DiagnosticBag,
): unknown {
  state.count += 1;
  if (state.count > limits.maxNodes) {
    bag.error("yaml.node_limit", path, "YAML document exceeds the configured node limit");
    return null;
  }
  if (depth > limits.maxDepth) {
    bag.error("yaml.depth_limit", path, "YAML document exceeds the configured nesting limit");
    return null;
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      bag.error("yaml.non_finite_number", path, "YAML numbers must be finite");
    } else if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      bag.error("yaml.unsafe_integer", path, "YAML integers must be exactly representable");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      normalizeYamlValue(item, pointer(path, index), depth + 1, state, limits, bag),
    );
  }
  if (!isPlainRecord(value)) {
    bag.error("yaml.unsupported_value", path, "YAML value is not supported");
    return null;
  }
  const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    if (!safeKey(key)) {
      bag.error("yaml.unsafe_key", path, "YAML mapping contains an unsafe key");
      continue;
    }
    normalized[key] = normalizeYamlValue(
      item,
      pointer(path, key),
      depth + 1,
      state,
      limits,
      bag,
    );
  }
  return normalized;
}

function resolveLimits(input: Partial<StrictYamlLimits>): StrictYamlLimits {
  const limits = { ...DEFAULT_STRICT_YAML_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`strict YAML limit ${name} must be a positive safe integer`);
    }
  }
  return limits;
}

function safeParserCode(code: string): string {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "SYNTAX";
}

function safeKey(key: string): boolean {
  return (
    key !== "__proto__" &&
    key !== "prototype" &&
    key !== "constructor" &&
    !/[\u0000-\u001f\u007f]/u.test(key) &&
    Buffer.byteLength(key, "utf8") <= 1024
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function isInspectableNode(value: unknown): value is Node | Pair {
  return isAlias(value) || isScalar(value) || isSeq(value) || isMap(value) || isPair(value);
}
