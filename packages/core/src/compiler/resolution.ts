import type {
  CompiledConfiguration,
  CompiledRunType,
  ConfigurationObject,
  ConfigurationValue,
} from "../contracts/configuration.js";
import type {
  ResolveCompiledPersonaOptions,
  ResolvedCompiledPersona,
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
    return failure("resolution.default_run_type", "/project/default_run_type", "project has no valid default run type");
  }
  const runType = configuration.run_types[selected];
  if (runType === undefined) {
    return failure("resolution.unknown_run_type", "/run_types", `run type ${selected} is not configured`);
  }
  return validationSuccess(runType);
}

/** Resolve persona resource inheritance plus run-type role/persona settings. */
export function resolveCompiledPersona(
  configuration: CompiledConfiguration,
  personaId: string,
  options: ResolveCompiledPersonaOptions = {},
): ValidationResult<ResolvedCompiledPersona> {
  const bag = new DiagnosticBag();
  if (personaId.trim().length === 0) {
    bag.error("resolution.persona_id", "/persona", "persona id must be a nonempty string");
    return validationFailure(bag.sorted());
  }
  const persona = configuration.registries.personas[personaId];
  if (persona === undefined) {
    bag.error("resolution.unknown_persona", "/persona", `persona ${personaId} is not configured`);
    return validationFailure(bag.sorted());
  }
  const path = `/registries/personas/${escapePointer(personaId)}`;
  const sourceId = stringField(persona, "id", path, bag);
  if (sourceId !== undefined && sourceId !== personaId) {
    bag.error("resolution.persona_registry_id", `${path}/id`, `persona id ${sourceId} does not match registry key ${personaId}`);
  }
  const modelRole = stringField(persona, "model_role", path, bag) ?? "";
  const agentId = optionalStringField(persona, "agent", path, bag);
  const agent = agentId === undefined ? undefined : configuration.agents[agentId];
  if (agentId !== undefined && agent === undefined) {
    bag.error("resolution.unknown_agent", `${path}/agent`, `persona ${personaId} references unknown agent ${agentId}`);
  }
  if (agentId === undefined && persona.prompt === undefined) {
    bag.error("resolution.persona_instructions", path, `persona ${personaId} must reference an agent or explicit prompt`);
  }

  let runType: CompiledRunType | undefined;
  if (options.runTypeId !== undefined) {
    const resolved = resolveCompiledRunType(configuration, options.runTypeId);
    if (!resolved.ok) bag.extend(resolved.diagnostics);
    else runType = resolved.value;
  }

  const agentDocument = agent?.document;
  const instructions = resolveInstructions(persona, agentDocument, path, bag);
  const capabilities = objectField(persona, "capabilities", path, bag) ??
    (agentDocument === undefined ? undefined : objectField(agentDocument, "capabilities", `/agents/${escapePointer(agentId!)}`, bag));
  if (capabilities === undefined) {
    bag.error("resolution.capabilities", path, `persona ${personaId} has no capabilities policy`);
  }
  const runSettings = resolveRunSettings(runType, personaId, modelRole, bag);
  const description = firstNonempty([
    optionalStringField(persona, "description", path, bag),
    agentDocument === undefined ? undefined : optionalStringField(agentDocument, "description", `/agents/${escapePointer(agentId!)}`, bag),
  ]) ?? "";
  const model = firstNonempty([
    options.model,
    runSettings.personaModel,
    runSettings.roleModel,
    optionalStringField(persona, "model", path, bag),
    agentDocument === undefined ? undefined : optionalStringField(agentDocument, "model", `/agents/${escapePointer(agentId!)}`, bag),
  ]);
  const thinkingLevel = firstNonempty([
    options.thinkingLevel,
    runSettings.personaThinking,
    runSettings.roleThinking,
    optionalStringField(persona, "thinking_level", path, bag),
    optionalStringField(persona, "reasoning_effort", path, bag),
    agentDocument === undefined ? undefined : optionalStringField(agentDocument, "thinking_level", `/agents/${escapePointer(agentId!)}`, bag),
  ]);
  const provider = agentDocument === undefined
    ? undefined
    : optionalStringField(agentDocument, "provider", `/agents/${escapePointer(agentId!)}`, bag);
  const skills = stringArrayField(persona, "skills", path, bag);

  if (bag.hasErrors() || instructions === undefined || capabilities === undefined) {
    return validationFailure(bag.sorted());
  }
  const resolved: ResolvedCompiledPersona = deepFreeze({
    id: personaId,
    model_role: modelRole,
    ...(agentId === undefined ? {} : { agent_id: agentId }),
    ...(agent === undefined ? {} : { agent_resource: agent }),
    description,
    instructions: instructions.text,
    instruction_source: instructions.source,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinking_level: thinkingLevel }),
    capabilities: cloneObject(capabilities),
    skills: Object.freeze(skills),
    ...(runType === undefined ? {} : { run_type: runType }),
  });
  return validationSuccess(resolved, bag.sorted());
}

function resolveInstructions(
  persona: ConfigurationObject,
  agent: ConfigurationObject | undefined,
  path: string,
  bag: DiagnosticBag,
): { text: string; source: string } | undefined {
  if (persona.prompt !== undefined) {
    bag.error(
      "resolution.unmaterialized_prompt",
      `${path}/prompt`,
      "persona prompt bytes are not materialized in the compiled configuration",
    );
    return undefined;
  }
  if (agent === undefined) return undefined;
  const agentPath = `/agents/${escapePointer(String(agent.id ?? "unknown"))}`;
  const instructions = objectField(agent, "instructions", agentPath, bag);
  if (instructions === undefined) return undefined;
  const source = stringField(instructions, "source", `${agentPath}/instructions`, bag);
  if (source === "inline") {
    const text = stringField(instructions, "text", `${agentPath}/instructions`, bag);
    return text === undefined ? undefined : { text, source: `${agentPath}/instructions/text` };
  }
  if (source === "file") {
    bag.error(
      "resolution.unmaterialized_instructions",
      `${agentPath}/instructions/path`,
      "file-backed agent instruction bytes are not materialized in the compiled configuration",
    );
    return undefined;
  }
  return undefined;
}

function resolveRunSettings(
  runType: CompiledRunType | undefined,
  personaId: string,
  modelRole: string,
  bag: DiagnosticBag,
): {
  personaModel?: string;
  personaThinking?: string;
  roleModel?: string;
  roleThinking?: string;
} {
  if (runType === undefined) return {};
  const root = `/run_types/${escapePointer(runType.id)}/agents`;
  const agents = objectField(runType.document, "agents", `/run_types/${escapePointer(runType.id)}`, bag);
  if (agents === undefined) return {};
  const personas = objectField(agents, "personas", root, bag) ?? {};
  const roles = objectField(agents, "roles", root, bag) ?? {};
  const persona = objectValue(personas[personaId], `${root}/personas/${escapePointer(personaId)}`, bag);
  const role = modelRole.length === 0
    ? undefined
    : objectValue(roles[modelRole], `${root}/roles/${escapePointer(modelRole)}`, bag);
  return compact({
    personaModel: persona === undefined ? undefined : optionalStringField(persona, "model", `${root}/personas/${escapePointer(personaId)}`, bag),
    personaThinking: persona === undefined ? undefined : firstNonempty([
      optionalStringField(persona, "thinking_level", `${root}/personas/${escapePointer(personaId)}`, bag),
      optionalStringField(persona, "reasoning_effort", `${root}/personas/${escapePointer(personaId)}`, bag),
    ]),
    roleModel: role === undefined ? undefined : optionalStringField(role, "model", `${root}/roles/${escapePointer(modelRole)}`, bag),
    roleThinking: role === undefined ? undefined : firstNonempty([
      optionalStringField(role, "thinking_level", `${root}/roles/${escapePointer(modelRole)}`, bag),
      optionalStringField(role, "reasoning_effort", `${root}/roles/${escapePointer(modelRole)}`, bag),
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
    bag.error("resolution.string", `${path}/${escapePointer(field)}`, `field ${field} must be a nonempty string`);
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

function stringArrayField(
  object: ConfigurationObject,
  field: string,
  path: string,
  bag: DiagnosticBag,
): string[] {
  const value = object[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    bag.error("resolution.string_array", `${path}/${escapePointer(field)}`, `field ${field} must be a string array`);
    return [];
  }
  const output: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim().length === 0) {
      bag.error("resolution.string_array", `${path}/${escapePointer(field)}/${index}`, `field ${field} contains an invalid string`);
    } else output.push(item);
  }
  return [...new Set(output)].sort(compareUtf8);
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
  const output: Record<string, ConfigurationValue> = Object.create(null) as Record<string, ConfigurationValue>;
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
