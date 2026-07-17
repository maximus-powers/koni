import type { JsonValue } from "../authority/protocol.js";

export const CONTROL_CATALOG_PROTOCOL = "koni.control-catalog.v1" as const;
export const CONFIG_CATALOG_PROTOCOL = "koni.config-catalog.v1" as const;
export const CONFIG_SNAPSHOT_PROTOCOL = "koni.config-snapshot.v1" as const;

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ControlThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Read-only projection of Pi's ordinary ModelRegistry, injected by the host. */
export interface ControlModelOption {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  /** Exact Pi-supported choices for this model; selectors must never invent another value. */
  thinkingLevels: readonly ControlThinkingLevel[];
  available: boolean;
  /** Human-readable explanation for a visible model that autonomous attempts cannot select. */
  unavailableReason?: string;
}

export interface ControlStageOption {
  id: string;
  title: string;
  kind: string;
  /** False means the stage stays visible in the flow but is muted for this run type. */
  included: boolean;
}

export interface ControlRoleDefault {
  id: string;
  title: string;
  provider: string;
  model: string;
  thinkingLevel: ControlThinkingLevel;
}

export interface ControlRunTypeOption {
  id: string;
  title: string;
  description: string;
  questionPolicy: "none" | "some" | "many";
  maxParallel: number;
  startMode: "planning" | "work";
  stages: readonly ControlStageOption[];
  roles: readonly ControlRoleDefault[];
}

/**
 * Authority-composed launch cards. This is presentation data only: run.create re-resolves and
 * validates every selected value against the current effective configuration.
 */
export interface ControlCatalog {
  protocol: typeof CONTROL_CATALOG_PROTOCOL;
  runTypes: readonly ControlRunTypeOption[];
}

export type ConfigFieldKind =
  | "text"
  | "multiline"
  | "integer"
  | "boolean"
  | "select"
  | "model"
  | "thinking"
  | "string_list";

export interface ConfigFieldOption {
  value: string;
  label: string;
  description?: string;
}

export interface ConfigFieldDefinition {
  /** Opaque semantic address understood only by config.get/config.update. Never shown as a path. */
  key: string;
  label: string;
  description: string;
  kind: ConfigFieldKind;
  options?: readonly ConfigFieldOption[];
  minimum?: number;
  maximum?: number;
}

/**
 * Authority-authored recipe for adding one semantic resource to a configuration section.
 * The template identity is opaque; the control center only presents its human copy.
 */
export interface ConfigResourceCreateOption {
  id: string;
  title: string;
  description: string;
  nameLabel: string;
  suggestedName: string;
}

export interface ConfigResourceDefinition {
  id: string;
  title: string;
  description: string;
  /** Optional semantic tree relation used only for guided presentation. */
  parentId?: string;
  depth?: number;
  canDuplicate?: boolean;
  canDelete?: boolean;
  /** Recipes for resources that may be created beneath this resource. */
  createOptions?: readonly ConfigResourceCreateOption[];
  fields: readonly ConfigFieldDefinition[];
}

export interface ConfigSectionDefinition {
  id: string;
  title: string;
  description: string;
  /** Recipes for top-level resources that may be created in this domain. */
  createOptions?: readonly ConfigResourceCreateOption[];
  resources: readonly ConfigResourceDefinition[];
}

export interface ConfigCatalog {
  protocol: typeof CONFIG_CATALOG_PROTOCOL;
  sections: readonly ConfigSectionDefinition[];
}

/** Hidden CAS material is round-tripped but never rendered to the operator. */
export interface ConfigSnapshot {
  protocol: typeof CONFIG_SNAPSHOT_PROTOCOL;
  cas: JsonValue;
  values: Readonly<Record<string, JsonValue>>;
}

export function parseControlCatalog(value: unknown): ControlCatalog {
  const root = requiredRecord(value, "control catalog");
  if (root.protocol !== CONTROL_CATALOG_PROTOCOL || !Array.isArray(root.runTypes)) {
    throw new Error("authority returned an unsupported control catalog");
  }
  const ids = new Set<string>();
  const runTypes = root.runTypes.map((item, index): ControlRunTypeOption => {
    const row = requiredRecord(item, `run type ${index + 1}`);
    const id = requiredText(row.id, "run type id");
    if (ids.has(id)) throw new Error(`authority returned duplicate run type ${id}`);
    ids.add(id);
    const questionPolicy = row.questionPolicy;
    if (questionPolicy !== "none" && questionPolicy !== "some" && questionPolicy !== "many") {
      throw new Error(`authority returned an invalid question policy for ${id}`);
    }
    const maxParallel = row.maxParallel;
    if (!Number.isSafeInteger(maxParallel) || typeof maxParallel !== "number" || maxParallel < 1) {
      throw new Error(`authority returned invalid parallelism for ${id}`);
    }
    if (row.startMode !== "planning" && row.startMode !== "work") {
      throw new Error(`authority returned an invalid start mode for ${id}`);
    }
    if (!Array.isArray(row.stages) || !Array.isArray(row.roles)) {
      throw new Error(`authority returned incomplete launch defaults for ${id}`);
    }
    return {
      id,
      title: requiredText(row.title, "run type title"),
      description: requiredText(row.description, "run type description"),
      questionPolicy,
      maxParallel,
      startMode: row.startMode,
      stages: row.stages.map((stage, stageIndex) => {
        const record = requiredRecord(stage, `stage ${stageIndex + 1}`);
        if (typeof record.included !== "boolean") throw new Error("authority returned an invalid stage inclusion");
        return {
          id: requiredText(record.id, "stage id"),
          title: requiredText(record.title, "stage title"),
          kind: requiredText(record.kind, "stage kind"),
          included: record.included,
        };
      }),
      roles: row.roles.map((role, roleIndex) => {
        const record = requiredRecord(role, `agent role ${roleIndex + 1}`);
        const thinkingLevel = record.thinkingLevel;
        if (!THINKING_LEVELS.includes(thinkingLevel as ControlThinkingLevel)) {
          throw new Error("authority returned an unsupported role thinking level");
        }
        return {
          id: requiredText(record.id, "agent role id"),
          title: requiredText(record.title, "agent role title"),
          provider: requiredText(record.provider, "agent role provider"),
          model: requiredText(record.model, "agent role model"),
          thinkingLevel: thinkingLevel as ControlThinkingLevel,
        };
      }),
    };
  });
  if (runTypes.length === 0) throw new Error("project has no runnable run types");
  return { protocol: CONTROL_CATALOG_PROTOCOL, runTypes };
}

export function parseConfigCatalog(value: unknown): ConfigCatalog {
  const root = requiredRecord(value, "configuration catalog");
  if (root.protocol !== CONFIG_CATALOG_PROTOCOL || !Array.isArray(root.sections)) {
    throw new Error("authority returned an unsupported configuration catalog");
  }
  return {
    protocol: CONFIG_CATALOG_PROTOCOL,
    sections: root.sections.map((section, sectionIndex) => {
      const row = requiredRecord(section, `configuration section ${sectionIndex + 1}`);
      if (!Array.isArray(row.resources)) throw new Error("configuration section has no resource list");
      return {
        id: requiredText(row.id, "configuration section id"),
        title: requiredText(row.title, "configuration section title"),
        description: requiredText(row.description, "configuration section description"),
        ...(row.createOptions === undefined ? {} : {
          createOptions: parseCreateOptions(row.createOptions, "configuration section"),
        }),
        resources: row.resources.map((resource, resourceIndex) => {
          const record = requiredRecord(resource, `configuration resource ${resourceIndex + 1}`);
          if (!Array.isArray(record.fields)) throw new Error("configuration resource has no field list");
          const depth = optionalSafeNumber(record.depth, "configuration resource depth");
          if (depth !== undefined && depth < 0) throw new Error("configuration resource depth is invalid");
          if (record.canDuplicate !== undefined && typeof record.canDuplicate !== "boolean") {
            throw new Error("configuration resource duplicate capability is invalid");
          }
          if (record.canDelete !== undefined && typeof record.canDelete !== "boolean") {
            throw new Error("configuration resource delete capability is invalid");
          }
          return {
            id: requiredText(record.id, "configuration resource id"),
            title: requiredText(record.title, "configuration resource title"),
            description: requiredText(record.description, "configuration resource description"),
            ...(typeof record.parentId === "string" ? { parentId: requiredText(record.parentId, "configuration resource parent") } : {}),
            ...(depth === undefined ? {} : { depth }),
            ...(record.canDuplicate === undefined ? {} : { canDuplicate: record.canDuplicate }),
            ...(record.canDelete === undefined ? {} : { canDelete: record.canDelete }),
            ...(record.createOptions === undefined ? {} : {
              createOptions: parseCreateOptions(record.createOptions, "configuration resource"),
            }),
            fields: record.fields.map(parseConfigField),
          };
        }),
      };
    }),
  };
}

function parseCreateOptions(value: unknown, label: string): ConfigResourceCreateOption[] {
  if (!Array.isArray(value)) throw new Error(`${label} create options are invalid`);
  return value.map((option, index) => {
    const row = requiredRecord(option, `${label} create option ${index + 1}`);
    return {
      id: requiredText(row.id, "configuration create option id"),
      title: requiredText(row.title, "configuration create option title"),
      description: requiredText(row.description, "configuration create option description"),
      nameLabel: requiredText(row.nameLabel, "configuration create option name label"),
      suggestedName: requiredText(row.suggestedName, "configuration create option suggested name"),
    };
  });
}

export function parseConfigSnapshot(value: unknown): ConfigSnapshot {
  const root = requiredRecord(value, "configuration snapshot");
  if (root.protocol !== CONFIG_SNAPSHOT_PROTOCOL || root.cas === undefined) {
    throw new Error("authority returned an unsupported configuration snapshot");
  }
  const values = requiredRecord(root.values, "configuration values");
  return {
    protocol: CONFIG_SNAPSHOT_PROTOCOL,
    cas: structuredClone(root.cas as JsonValue),
    values: structuredClone(values) as Record<string, JsonValue>,
  };
}

function parseConfigField(value: unknown, index: number): ConfigFieldDefinition {
  const row = requiredRecord(value, `configuration field ${index + 1}`);
  const kind = row.kind;
  if (!new Set<ConfigFieldKind>([
    "text", "multiline", "integer", "boolean", "select", "model", "thinking", "string_list",
  ]).has(kind as ConfigFieldKind)) throw new Error("configuration field has an unsupported kind");
  const options = row.options;
  if (options !== undefined && !Array.isArray(options)) throw new Error("configuration field options are invalid");
  const minimum = optionalSafeNumber(row.minimum, "configuration field minimum");
  const maximum = optionalSafeNumber(row.maximum, "configuration field maximum");
  return {
    key: requiredText(row.key, "configuration field key"),
    label: requiredText(row.label, "configuration field label"),
    description: requiredText(row.description, "configuration field description"),
    kind: kind as ConfigFieldKind,
    ...(options === undefined ? {} : {
      options: options.map((option, optionIndex) => {
        const item = requiredRecord(option, `configuration field option ${optionIndex + 1}`);
        return {
          value: requiredText(item.value, "configuration option value"),
          label: requiredText(item.label, "configuration option label"),
          ...(typeof item.description === "string" ? { description: item.description } : {}),
        };
      }),
    }),
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
  };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is missing`);
  return value;
}

function optionalSafeNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${label} is invalid`);
  return value;
}
