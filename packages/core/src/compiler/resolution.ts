import type {
  CompiledConfiguration,
  CompiledRunType,
  ConfigurationObject,
  ConfigurationValue,
} from "../contracts/configuration.js";
import type {
  ResolveCompiledAgentOptions,
  ResolvedCompiledAgent,
} from "../contracts/resolution.js";
import { compareUtf8 } from "../shared/canonical.js";
import {
  DiagnosticBag,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from "../shared/diagnostics.js";

export function resolveCompiledRunType(
  configuration: CompiledConfiguration,
  id?: string,
): ValidationResult<CompiledRunType> {
  const selected = id ?? defaultRunTypeId(configuration);
  if (selected === undefined || selected.trim().length === 0) {
    return failure(
      "resolution.default_run_type",
      "/project/default_run_type",
      "project has no valid default run type",
    );
  }
  const runType = configuration.run_types[selected];
  if (runType === undefined) {
    return failure(
      "resolution.unknown_run_type",
      "/run_types",
      `run type ${selected} is not configured`,
    );
  }
  return validationSuccess(runType);
}

/** Resolve one unified agent plus run-type role/agent settings. */
export function resolveCompiledAgent(
  configuration: CompiledConfiguration,
  agentId: string,
  options: ResolveCompiledAgentOptions = {},
): ValidationResult<ResolvedCompiledAgent> {
  const bag = new DiagnosticBag();
  if (agentId.trim().length === 0) {
    bag.error("resolution.agent_id", "/agent", "agent id must be a nonempty string");
    return validationFailure(bag.sorted());
  }
  const agent = configuration.agents[agentId];
  if (agent === undefined) {
    bag.error("resolution.unknown_agent", "/agent", `agent ${agentId} is not configured`);
    return validationFailure(bag.sorted());
  }
  const document = agent.document;
  const path = `/agents/${escapePointer(agentId)}`;
  const sourceId = stringField(document, "id", path, bag);
  if (sourceId !== undefined && sourceId !== agentId) {
    bag.error(
      "resolution.agent_registry_id",
      `${path}/id`,
      `agent id ${sourceId} does not match registry key ${agentId}`,
    );
  }
  const pi = objectField(document, "pi", path, bag) ?? {};
  const koni = objectField(document, "koni", path, bag) ?? {};
  const role = stringField(koni, "role", `${path}/koni`, bag) ?? "";

  let runType: CompiledRunType | undefined;
  if (options.runTypeId !== undefined) {
    const resolved = resolveCompiledRunType(configuration, options.runTypeId);
    if (!resolved.ok) bag.extend(resolved.diagnostics);
    else runType = resolved.value;
  }

  const instructions = stringField(document, "instructions", path, bag);
  const capabilities = objectField(koni, "capabilities", `${path}/koni`, bag);
  if (capabilities === undefined) {
    bag.error("resolution.capabilities", path, `agent ${agentId} has no capabilities policy`);
  }
  const runSettings = resolveRunSettings(runType, agentId, role, bag);
  const description = optionalStringField(document, "description", path, bag) ?? "";
  const model = firstNonempty([
    options.model,
    runSettings.personaModel,
    runSettings.roleModel,
    optionalStringField(pi, "model", `${path}/pi`, bag),
  ]);
  const thinkingLevel = firstNonempty([
    options.thinkingLevel,
    runSettings.personaThinking,
    runSettings.roleThinking,
    optionalStringField(pi, "thinking_level", `${path}/pi`, bag),
  ]);
  const provider = firstNonempty([
    runSettings.personaProvider,
    runSettings.roleProvider,
    optionalStringField(pi, "provider", `${path}/pi`, bag),
  ]);

  if (bag.hasErrors() || instructions === undefined || capabilities === undefined) {
    return validationFailure(bag.sorted());
  }
  const resolved: ResolvedCompiledAgent = deepFreeze({
    id: agentId,
    role,
    resource: agent,
    description,
    instructions,
    instruction_source: `${path}/instructions`,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinking_level: thinkingLevel }),
    capabilities: cloneObject(capabilities),
    ...(runType === undefined ? {} : { run_type: runType }),
  });
  return validationSuccess(resolved, bag.sorted());
}

function resolveRunSettings(
  runType: CompiledRunType | undefined,
  personaId: string,
  modelRole: string,
  bag: DiagnosticBag,
): {
  personaProvider?: string;
  personaModel?: string;
  personaThinking?: string;
  roleProvider?: string;
  roleModel?: string;
  roleThinking?: string;
} {
  if (runType === undefined) return {};
  const root = `/run_types/${escapePointer(runType.id)}/agents`;
  const agents = objectField(
    runType.document,
    "agents",
    `/run_types/${escapePointer(runType.id)}`,
    bag,
  );
  if (agents === undefined) return {};
  const personas = objectField(agents, "overrides", root, bag) ?? {};
  const roles = objectField(agents, "roles", root, bag) ?? {};
  const persona = objectValue(
    personas[personaId],
    `${root}/overrides/${escapePointer(personaId)}`,
    bag,
  );
  const role =
    modelRole.length === 0
      ? undefined
      : objectValue(roles[modelRole], `${root}/roles/${escapePointer(modelRole)}`, bag);
  return compact({
    personaProvider:
      persona === undefined
        ? undefined
        : optionalStringField(
            persona,
            "provider",
            `${root}/overrides/${escapePointer(personaId)}`,
            bag,
          ),
    personaModel:
      persona === undefined
        ? undefined
        : optionalStringField(
            persona,
            "model",
            `${root}/overrides/${escapePointer(personaId)}`,
            bag,
          ),
    personaThinking:
      persona === undefined
        ? undefined
        : firstNonempty([
            optionalStringField(
              persona,
              "thinking_level",
              `${root}/overrides/${escapePointer(personaId)}`,
              bag,
            ),
            optionalStringField(
              persona,
              "reasoning_effort",
              `${root}/overrides/${escapePointer(personaId)}`,
              bag,
            ),
          ]),
    roleProvider:
      role === undefined
        ? undefined
        : optionalStringField(role, "provider", `${root}/roles/${escapePointer(modelRole)}`, bag),
    roleModel:
      role === undefined
        ? undefined
        : optionalStringField(role, "model", `${root}/roles/${escapePointer(modelRole)}`, bag),
    roleThinking:
      role === undefined
        ? undefined
        : firstNonempty([
            optionalStringField(
              role,
              "thinking_level",
              `${root}/roles/${escapePointer(modelRole)}`,
              bag,
            ),
            optionalStringField(
              role,
              "reasoning_effort",
              `${root}/roles/${escapePointer(modelRole)}`,
              bag,
            ),
          ]),
  });
}

function defaultRunTypeId(configuration: CompiledConfiguration): string | undefined {
  const value = configuration.project.default_run_type;
  return typeof value === "string" ? value : undefined;
}

function stringField(
  object: ConfigurationObject,
  field: string,
  path: string,
  bag: DiagnosticBag,
): string | undefined {
  const value = object[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    bag.error(
      "resolution.string",
      `${path}/${escapePointer(field)}`,
      `field ${field} must be a nonempty string`,
    );
    return undefined;
  }
  return value;
}

function optionalStringField(
  object: ConfigurationObject,
  field: string,
  path: string,
  bag: DiagnosticBag,
): string | undefined {
  return object[field] === undefined ? undefined : stringField(object, field, path, bag);
}

function objectField(
  object: ConfigurationObject,
  field: string,
  path: string,
  bag: DiagnosticBag,
): ConfigurationObject | undefined {
  const value = object[field];
  if (value === undefined) return undefined;
  return objectValue(value, `${path}/${escapePointer(field)}`, bag);
}

function objectValue(
  value: ConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): ConfigurationObject | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    bag.error("resolution.mapping", path, "expected a mapping");
    return undefined;
  }
  return value as ConfigurationObject;
}

function firstNonempty(values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}

function compact<Value extends Record<string, string | undefined>>(
  value: Value,
): { [Key in keyof Value]?: string } {
  const output: Partial<Record<keyof Value, string>> = {};
  for (const key of Object.keys(value) as (keyof Value)[]) {
    const item = value[key];
    if (item !== undefined) output[key] = item;
  }
  return output;
}

function cloneValue(value: ConfigurationValue): ConfigurationValue {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (typeof value === "object" && value !== null) return cloneObject(value as ConfigurationObject);
  return value;
}

function cloneObject(value: ConfigurationObject): ConfigurationObject {
  const output: Record<string, ConfigurationValue> = Object.create(null) as Record<
    string,
    ConfigurationValue
  >;
  for (const key of Object.keys(value).sort(compareUtf8)) output[key] = cloneValue(value[key]!);
  return output;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function failure<Value>(code: string, path: string, message: string): ValidationResult<Value> {
  const bag = new DiagnosticBag();
  bag.error(code, path, message);
  return validationFailure(bag.sorted());
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
