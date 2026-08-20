import { TextDecoder } from "node:util";
import type {
  ConfigurationRegistryKind,
  ProfileImportCategory,
} from "../contracts/configuration.js";

export const REQUIRED_IMPORT_CATEGORIES: readonly ProfileImportCategory[] = [
  "graph",
  "rules",
  "operations",
  "workflows",
  "actions",
  "checks",
  "reports",
  "cockpit",
];

export const PI_THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export const CONFIGURATION_ENGINE_VERSION = "0.1.0";

export const PROFILE_TOP_LEVEL_FIELDS = [
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

export const RUN_IDENTITY_FIELDS = ["schema_version", "id", "title", "description"] as const;
export const RUN_BEHAVIOR_FIELDS = [
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
export const RUN_SOURCE_FIELDS = [
  ...RUN_IDENTITY_FIELDS,
  ...RUN_BEHAVIOR_FIELDS,
  "extends",
  "overrides",
];

export const MODULE_PAYLOADS: Readonly<Record<ProfileImportCategory, readonly string[]>> = {
  graph: ["node_types", "edge_types", "queries", "graph_constraints", "gate_policies"],
  rules: ["rules", "queries", "state_machines"],
  operations: ["operations"],
  workflows: ["workflows"],
  actions: ["actions"],
  checks: ["checks"],
  reports: ["reports"],
  cockpit: ["views"],
  lifecycles: ["state_machines"],
};

export const PAYLOAD_REGISTRIES: Readonly<Partial<Record<string, ConfigurationRegistryKind>>> = {
  node_types: "node_types",
  queries: "queries",
  graph_constraints: "graph_constraints",
  gate_policies: "gate_policies",
  rules: "rules",
  operations: "operations",
  workflows: "workflows",
  actions: "actions",
  checks: "checks",
  reports: "reports",
  views: "views",
  state_machines: "state_machines",
};

export const RUN_OVERRIDE_ROOTS = new Set<string>(RUN_BEHAVIOR_FIELDS);
export const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export type MutableConfigurationValue =
  null | boolean | number | string | MutableConfigurationObject | MutableConfigurationValue[];

export interface MutableConfigurationObject {
  [key: string]: MutableConfigurationValue;
}

export function isMutableRecord(value: unknown): value is MutableConfigurationObject {
  return isPlainRecord(value);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

export function toMutableObject(value: Record<string, unknown>): MutableConfigurationObject {
  const normalized = cloneUnknown(value);
  if (!isMutableRecord(normalized)) {
    throw new TypeError("strict YAML object normalization produced a non-object");
  }
  return normalized;
}

export function cloneUnknown(value: unknown): MutableConfigurationValue {
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

export function cloneValue(value: MutableConfigurationValue): MutableConfigurationValue {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (isMutableRecord(value)) {
    return cloneObject(value);
  }
  return value;
}

export function cloneObject(value: MutableConfigurationObject): MutableConfigurationObject {
  const result: MutableConfigurationObject = Object.create(null) as MutableConfigurationObject;
  for (const [key, item] of Object.entries(value)) {
    result[key] = cloneValue(item);
  }
  return result;
}

export function deepFreeze<Value>(value: Value): Value {
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
