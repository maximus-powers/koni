import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  THINKING_LEVELS,
  type ControlModelOption,
  type ControlRoleDefault,
  type ControlThinkingLevel,
} from "../control-center/protocol.js";

export interface PiModelDescriptor {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  /** Pi's model-specific map: null is unsupported; xhigh/max require explicit entries. */
  thinkingLevelMap?: Partial<Record<ControlThinkingLevel, string | null>>;
}

export interface SealedRoleModelSelection extends Pick<
  ControlRoleDefault,
  "id" | "title" | "provider" | "model" | "thinkingLevel"
> {}

export type SealedRoleModelOverrides = Readonly<Record<string, Partial<Pick<
  SealedRoleModelSelection,
  "provider" | "model" | "thinkingLevel"
>>>>;

export interface SealedModelAdmissionIssue {
  code: "model_unavailable" | "thinking_level_unsupported";
  roleId: string;
  message: string;
}

export class SealedModelAdmissionError extends Error {
  public readonly code: SealedModelAdmissionIssue["code"];
  public readonly roleId: string;

  public constructor(issue: SealedModelAdmissionIssue) {
    super(issue.message);
    this.name = "SealedModelAdmissionError";
    this.code = issue.code;
    this.roleId = issue.roleId;
  }
}

export interface SealedPiModelRuntimeProjection {
  getModels(): readonly PiModelDescriptor[];
  getAvailableSnapshot(): readonly PiModelDescriptor[];
}

export interface AmbientPiModelRegistryProjection {
  getAll(): readonly PiModelDescriptor[];
  /** Availability is intentionally not consumed; an ambient extension may influence that view. */
  getRegisteredProviderIds?(): readonly string[];
}

export interface LoadSealedPiModelCatalogOptions {
  /** Tests may inject an isolated runtime; production always constructs a fresh Pi runtime. */
  runtime?: SealedPiModelRuntimeProjection;
  /** Present only in the interactive Pi host. It is never registered on the sealed runtime. */
  ambientRegistry?: AmbientPiModelRegistryProjection;
}

/**
 * Build the model catalog a contained Koni attempt can actually execute.
 *
 * The fresh runtime deliberately uses Pi's ordinary auth.json/models.json paths and normal model
 * cache, but disables network refresh. That mirrors contained startup without importing ambient
 * extension provider functions or causing a provider turn. Unsupported ambient entries remain
 * visible to the control protocol as unavailable diagnostics.
 */
export async function loadSealedPiModelCatalog(
  options: LoadSealedPiModelCatalogOptions = {},
): Promise<ControlModelOption[]> {
  const runtime = options.runtime ?? await ModelRuntime.create({ allowModelNetwork: false });
  return projectSealedPiModelCatalog(runtime, options.ambientRegistry);
}

/** Pure projection used by both `/koni` and standalone `koni tui`. */
export function projectSealedPiModelCatalog(
  runtime: SealedPiModelRuntimeProjection,
  ambientRegistry?: AmbientPiModelRegistryProjection,
): ControlModelOption[] {
  const sealedModels = uniqueModels(runtime.getModels());
  const sealedAvailable = modelKeys(runtime.getAvailableSnapshot());
  const ambientModels = uniqueModels(ambientRegistry?.getAll() ?? []);
  const registeredProviders = new Set(ambientRegistry?.getRegisteredProviderIds?.() ?? []);
  const sealedKeys = modelKeys(sealedModels);

  const projected: ControlModelOption[] = sealedModels.map((model) => {
    const available = sealedAvailable.has(modelKey(model));
    return {
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      thinkingLevels: supportedThinkingLevels(model),
      available,
      ...(available ? {} : {
        unavailableReason:
          `The contained Pi runtime did not make ${model.provider}/${model.id} available under the current Pi credentials.`,
      }),
    };
  });

  for (const model of ambientModels) {
    if (sealedKeys.has(modelKey(model))) continue;
    const extensionOnly = registeredProviders.has(model.provider);
    projected.push({
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      thinkingLevels: supportedThinkingLevels(model),
      available: false,
      unavailableReason: extensionOnly
        ? "This provider comes from an ambient Pi extension; contained Koni attempts do not load ambient extensions."
        : "This model is absent from the contained Pi runtime's offline startup catalog.",
    });
  }

  return projected.sort((left, right) =>
    Number(right.available) - Number(left.available)
      || left.provider.localeCompare(right.provider)
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id));
}

/**
 * Return the first reason these exact role selections cannot execute in a contained Pi session.
 * Defaults remain visible: this function reports them instead of silently replacing either model
 * or thinking level.
 */
export function sealedModelAdmissionIssue(
  roles: readonly SealedRoleModelSelection[],
  models: readonly ControlModelOption[],
  overrides: SealedRoleModelOverrides = {},
): SealedModelAdmissionIssue | undefined {
  for (const role of roles) {
    const override = overrides[role.id];
    const provider = override?.provider ?? role.provider;
    const modelId = override?.model ?? role.model;
    const thinkingLevel = override?.thinkingLevel ?? role.thinkingLevel;
    const model = models.find((candidate) => candidate.provider === provider && candidate.id === modelId);
    if (model?.available !== true) {
      const reason = model?.unavailableReason
        ?? "This model is not executable by the contained Pi runtime.";
      return {
        code: "model_unavailable",
        roleId: role.id,
        message: `${role.title}: ${provider}/${modelId} is unavailable. ${reason}`,
      };
    }
    if (!model.thinkingLevels.includes(thinkingLevel)) {
      const choices = model.thinkingLevels.join(", ");
      return {
        code: "thinking_level_unsupported",
        roleId: role.id,
        message: `${role.title}: ${provider}/${modelId} does not support ${thinkingLevel} reasoning. Supported: ${choices || "none"}.`,
      };
    }
  }
  return undefined;
}

/** Fail before `run.create`; no durable run or provider attempt may be created on this error. */
export function assertSealedModelAdmission(
  roles: readonly SealedRoleModelSelection[],
  models: readonly ControlModelOption[],
  overrides: SealedRoleModelOverrides = {},
): void {
  const issue = sealedModelAdmissionIssue(roles, models, overrides);
  if (issue !== undefined) throw new SealedModelAdmissionError(issue);
}

/** Pi 0.80.10 `getSupportedThinkingLevels()` semantics, projected without provider functions. */
export function supportedThinkingLevels(model: PiModelDescriptor): ControlThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function uniqueModels(models: readonly PiModelDescriptor[]): PiModelDescriptor[] {
  const byKey = new Map<string, PiModelDescriptor>();
  for (const model of models) {
    if (model.provider.trim().length === 0 || model.id.trim().length === 0) continue;
    if (!byKey.has(modelKey(model))) {
      byKey.set(modelKey(model), {
        ...model,
        ...(model.thinkingLevelMap === undefined
          ? {}
          : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
      });
    }
  }
  return [...byKey.values()];
}

function modelKeys(models: readonly Pick<PiModelDescriptor, "provider" | "id">[]): Set<string> {
  return new Set(models.map(modelKey));
}

function modelKey(model: Pick<PiModelDescriptor, "provider" | "id">): string {
  return `${model.provider}\0${model.id}`;
}
