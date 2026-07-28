import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  THINKING_LEVELS,
  type ControlModelOption,
  type ControlRoleDefault,
  type ControlThinkingLevel,
} from "../control-center/protocol.js";
import { canonicalHash, type Sha256Digest } from "../shared/canonical.js";

export interface PiModelDescriptor {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  /** Pi's model-specific map: null is unsupported; xhigh/max require explicit entries. */
  thinkingLevelMap?: Partial<Record<ControlThinkingLevel, string | null>>;
}

/**
 * Secret-free transport identity persisted in every compiler-issued launch specification.
 *
 * Pi model headers are deliberately excluded: extensions and provider configuration may place
 * credentials there. The contained runtime compares this digest against its own freshly loaded
 * model before any provider request, so mutable catalog routing/capability drift fails closed
 * without copying provider secrets into Koni state.
 */
export interface SealedPiModelDescriptor {
  provider: string;
  id: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  input: readonly ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Readonly<Partial<Record<ControlThinkingLevel, string | null>>>;
  compat?: CanonicalJsonObject;
}

export interface SealedPiModelBinding {
  provider: string;
  id: string;
  api: string;
  /** Authenticated total provider context capacity, distinct from maximum generated output. */
  catalogContextWindow: number;
  catalogMaxTokens: number;
  catalogSha256: Sha256Digest;
}

export interface SealedPiModelBindingRuntime {
  getAvailableSnapshot(): readonly Model<Api>[];
}

export interface LoadSealedPiModelBindingOptions {
  /** Tests may inject an isolated runtime; production always constructs a fresh offline Pi runtime. */
  runtime?: SealedPiModelBindingRuntime;
}

export class SealedPiModelBindingError extends Error {
  public readonly code: "model_unavailable" | "model_descriptor_invalid";

  public constructor(code: "model_unavailable" | "model_descriptor_invalid", message: string) {
    super(message);
    this.name = "SealedPiModelBindingError";
    this.code = code;
  }
}

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | CanonicalJsonObject;
interface CanonicalJsonObject {
  [key: string]: CanonicalJson;
}

export interface SealedRoleModelSelection extends Pick<
  ControlRoleDefault,
  "id" | "title" | "provider" | "model" | "thinkingLevel"
> {}

export type SealedRoleModelOverrides = Readonly<
  Record<string, Partial<Pick<SealedRoleModelSelection, "provider" | "model" | "thinkingLevel">>>
>;

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
  const runtime = options.runtime ?? (await ModelRuntime.create({ allowModelNetwork: false }));
  return projectSealedPiModelCatalog(runtime, options.ambientRegistry);
}

/**
 * Load and seal one executable model from Pi's ordinary offline availability snapshot.
 * No provider registration, credential rewrite, model refresh, or network access occurs here.
 */
export async function loadSealedPiModelBinding(
  provider: string,
  id: string,
  options: LoadSealedPiModelBindingOptions = {},
): Promise<SealedPiModelBinding> {
  const runtime = options.runtime ?? (await ModelRuntime.create({ allowModelNetwork: false }));
  const matches = runtime
    .getAvailableSnapshot()
    .filter((candidate) => candidate.provider === provider && candidate.id === id);
  if (matches.length !== 1) {
    throw new SealedPiModelBindingError(
      "model_unavailable",
      matches.length === 0
        ? `The contained Pi runtime cannot execute ${provider}/${id} under the current Pi configuration.`
        : `The contained Pi runtime exposed an ambiguous catalog identity for ${provider}/${id}.`,
    );
  }
  return sealPiModelDescriptor(matches[0]!);
}

/** Build the exact secret-free catalog projection used by both compiler and contained runtime. */
export function sealedPiModelDescriptor(model: Readonly<Model<Api>>): SealedPiModelDescriptor {
  assertNonemptyModelText(model.provider, "provider");
  assertNonemptyModelText(model.id, "id");
  assertNonemptyModelText(model.api, "api");
  assertNonemptyModelText(model.baseUrl, "baseUrl");
  let endpoint: URL;
  try {
    endpoint = new URL(model.baseUrl);
  } catch {
    throw new SealedPiModelBindingError(
      "model_descriptor_invalid",
      "Pi model baseUrl is not an absolute URL",
    );
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    throw new SealedPiModelBindingError(
      "model_descriptor_invalid",
      "Pi model baseUrl must not embed credentials in compiler-persisted model identity",
    );
  }
  assertPositiveSafeInteger(model.contextWindow, "contextWindow");
  assertPositiveSafeInteger(model.maxTokens, "maxTokens");
  if (model.maxTokens > model.contextWindow) {
    throw new SealedPiModelBindingError(
      "model_descriptor_invalid",
      "Pi model maxTokens cannot exceed its context window",
    );
  }
  if (typeof model.reasoning !== "boolean") {
    throw new SealedPiModelBindingError(
      "model_descriptor_invalid",
      "Pi model reasoning capability is invalid",
    );
  }
  if (
    !Array.isArray(model.input) ||
    model.input.length === 0 ||
    model.input.some((entry) => entry !== "text" && entry !== "image")
  ) {
    throw new SealedPiModelBindingError(
      "model_descriptor_invalid",
      "Pi model input capabilities are invalid",
    );
  }
  const thinkingLevelMap =
    model.thinkingLevelMap === undefined
      ? undefined
      : canonicalThinkingLevelMap(model.thinkingLevelMap);
  const compat =
    model.compat === undefined
      ? undefined
      : canonicalJsonObject(model.compat, "compat", new Set<object>());
  return {
    provider: model.provider,
    id: model.id,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    ...(compat === undefined ? {} : { compat }),
  };
}

/** Seal a Pi model without ever serializing its optional headers or cost/credential state. */
export function sealPiModelDescriptor(model: Readonly<Model<Api>>): SealedPiModelBinding {
  const descriptor = sealedPiModelDescriptor(model);
  return {
    provider: descriptor.provider,
    id: descriptor.id,
    api: descriptor.api,
    catalogContextWindow: descriptor.contextWindow,
    catalogMaxTokens: descriptor.maxTokens,
    catalogSha256: canonicalHash(descriptor),
  };
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
      ...(available
        ? {}
        : {
            unavailableReason: `The contained Pi runtime did not make ${model.provider}/${model.id} available under the current Pi credentials.`,
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

  return projected.sort(
    (left, right) =>
      Number(right.available) - Number(left.available) ||
      left.provider.localeCompare(right.provider) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
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
    const model = models.find(
      (candidate) => candidate.provider === provider && candidate.id === modelId,
    );
    if (model?.available !== true) {
      const reason =
        model?.unavailableReason ?? "This model is not executable by the contained Pi runtime.";
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

function canonicalThinkingLevelMap(
  value: NonNullable<Model<Api>["thinkingLevelMap"]>,
): Partial<Record<ControlThinkingLevel, string | null>> {
  const result: Partial<Record<ControlThinkingLevel, string | null>> = {};
  for (const level of THINKING_LEVELS) {
    const mapped = value[level];
    if (mapped === undefined) continue;
    if (mapped !== null && typeof mapped !== "string") {
      throw new SealedPiModelBindingError(
        "model_descriptor_invalid",
        "Pi thinking-level mapping is invalid",
      );
    }
    result[level] = mapped;
  }
  return result;
}

function canonicalJsonObject(
  value: unknown,
  label: string,
  ancestors: Set<object>,
): CanonicalJsonObject {
  const projected = canonicalJson(value, label, ancestors);
  if (projected === null || Array.isArray(projected) || typeof projected !== "object") {
    throw new SealedPiModelBindingError(
      "model_descriptor_invalid",
      `${label} must be a plain object`,
    );
  }
  return projected;
}

function canonicalJson(value: unknown, label: string, ancestors: Set<object>): CanonicalJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new SealedPiModelBindingError(
        "model_descriptor_invalid",
        `${label} contains an invalid number`,
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new SealedPiModelBindingError("model_descriptor_invalid", `${label} contains a cycle`);
    }
    ancestors.add(value);
    try {
      return value.map((entry, index) => canonicalJson(entry, `${label}[${index}]`, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new SealedPiModelBindingError(
      "model_descriptor_invalid",
      `${label} contains a non-JSON value`,
    );
  }
  if (ancestors.has(value)) {
    throw new SealedPiModelBindingError("model_descriptor_invalid", `${label} contains a cycle`);
  }
  ancestors.add(value);
  const projected: CanonicalJsonObject = Object.create(null) as CanonicalJsonObject;
  try {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      projected[key] = canonicalJson(entry, `${label}.${key}`, ancestors);
    }
    return projected;
  } finally {
    ancestors.delete(value);
  }
}

function assertNonemptyModelText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    throw new SealedPiModelBindingError(
      "model_descriptor_invalid",
      `Pi model ${label} is empty or invalid`,
    );
  }
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new SealedPiModelBindingError(
      "model_descriptor_invalid",
      `Pi model ${label} must be a positive safe integer`,
    );
  }
}
