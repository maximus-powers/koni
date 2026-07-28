import { randomUUID } from "node:crypto";
import type { JsonValue } from "../authority/protocol.js";
import {
  parseControlCatalog,
  type ControlIntakeField,
  type ControlModelOption,
  type ControlRoleDefault,
  type ControlRunTypeOption,
  type ControlThinkingLevel,
} from "../control-center/protocol.js";
import type { ConfigurationObject, ConfigurationValue } from "../contracts/configuration.js";
import {
  createRunTargetDraft,
  cycleRunTarget,
  isCreatingNewTarget,
  resolveRunTarget,
  type RunTargetBranch,
  type RunTargetDraft,
} from "../control-center/run-target.js";
import type { MonitorAuthorityConnection } from "./client.js";

export type RunIntakeBranch = RunTargetBranch;

export interface GuidedRunRoleSelection extends ControlRoleDefault {}

export type GuidedRunFocus =
  | "objective"
  | `intake:${string}`
  | "run_type"
  | "branch"
  | "branch_name"
  | "questions"
  | "parallel"
  | `role:${string}:model`
  | `role:${string}:reasoning`
  | "start";

export interface GuidedRunState {
  objective: string;
  /** Unicode code-point offset, matching the full control-center editor. */
  objectiveCursor: number;
  /** Canonical typed values; text-like editors are parsed into these at submission. */
  intake: Record<string, ConfigurationValue>;
  intakeText: Record<string, string>;
  intakeCursors: Record<string, number>;
  intakeOptionIndexes: Record<string, number>;
  runTypes: readonly ControlRunTypeOption[];
  runTypeIndex: number;
  target: RunTargetDraft;
  models: readonly ControlModelOption[];
  questionPolicy: "none" | "some" | "many";
  maxParallel: number;
  roles: readonly GuidedRunRoleSelection[];
  focus: GuidedRunFocus;
  scroll: number;
  busy: boolean;
  error: string | undefined;
}

export interface GuidedRunCreateInput {
  objective: string;
  runTypeId: string;
  targetRef: string;
  /** Present only when provisioning a new target branch (see run-target/TargetProvisioning). */
  createTarget?: true;
  baseRef?: string;
  intake: ConfigurationObject;
  overrides: {
    questionPolicy: "none" | "some" | "many";
    maxParallel: number;
    roles: Record<string, { provider: string; model: string; thinkingLevel: ControlThinkingLevel }>;
  };
}

export type PrepareRunIntakeResult =
  | { kind: "blocked"; reason: "untrusted" | "uninitialized"; message: string }
  | { kind: "ready"; session: GuidedRunIntakeSession; state: GuidedRunState };

export interface PrepareRunIntakeOptions {
  trusted: boolean;
  initialized: boolean;
  /** Explicit command connector. Unlike passive monitoring, this may ensure/start authority. */
  connect: () => Promise<MonitorAuthorityConnection>;
  models: readonly ControlModelOption[];
  requestedRunType?: string;
  idempotencyKey?: () => string;
}

export class GuidedRunIntakeSession {
  readonly #connect: () => Promise<MonitorAuthorityConnection>;
  readonly #idempotencyKey: () => string;
  #closed = false;
  #started = false;

  public constructor(
    connect: () => Promise<MonitorAuthorityConnection>,
    idempotencyKey = () => `pi-run-create:${randomUUID()}`,
  ) {
    this.#connect = connect;
    this.#idempotencyKey = idempotencyKey;
  }

  public async create(state: GuidedRunState): Promise<{ runId: string; warning?: string }> {
    if (this.#closed) throw new Error("run intake is closed");
    if (this.#started) throw new Error("run intake has already been submitted");
    this.#started = true;
    try {
      const input = buildGuidedRunCreateInput(state);
      const idempotencyKey = this.#idempotencyKey();
      const connection = await this.#connect();
      try {
        const response = await connection.request("run.create", input as unknown as JsonValue, {
          expectedRevision: connection.revision,
          idempotencyKey,
        });
        if (
          !isRecord(response.result) ||
          typeof response.result.runId !== "string" ||
          response.result.runId.length === 0
        ) {
          throw new Error("authority returned an invalid run creation response");
        }
        const warning = response.result.warning;
        return {
          runId: response.result.runId,
          ...(typeof warning === "string" && warning.length > 0 ? { warning } : {}),
        };
      } finally {
        connection.close();
      }
    } catch (error) {
      // A failed attempt may be corrected in the still-open modal and retried. Each attempt mints
      // a fresh idempotency key: reusing one across edited inputs would be rejected as idempotency
      // reuse, while the rare commit-then-lost-response duplicate stays visible in the monitor and
      // is preferable to refusing every retry.
      this.#started = false;
      throw error;
    }
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
  }
}

export async function prepareGuidedRunIntake(
  options: PrepareRunIntakeOptions,
): Promise<PrepareRunIntakeResult> {
  if (!options.trusted) {
    return {
      kind: "blocked",
      reason: "untrusted",
      message: "Trust this project in Pi before starting Koni. Ordinary Pi chat remains available.",
    };
  }
  if (!options.initialized) {
    return {
      kind: "blocked",
      reason: "uninitialized",
      message:
        "Koni is not initialized in this repository. Run `/koni init coding` or `/koni init research`, then retry `/koni-run`.",
    };
  }
  const connection = await options.connect();
  try {
    const [catalogResponse, branchesResponse] = await Promise.all([
      connection.request("control.catalog"),
      connection.request("branches.list", { limit: 30 }),
    ]);
    const catalog = parseControlCatalog(catalogResponse.result);
    const branches = parseRunIntakeBranches(branchesResponse.result);
    if (branches.length === 0) throw new Error("repository has no local target branches");
    const state = createGuidedRunState({
      runTypes: catalog.runTypes,
      defaultRunTypeId: catalog.defaultRunTypeId,
      branches,
      models: options.models,
      ...(options.requestedRunType === undefined
        ? {}
        : { requestedRunType: options.requestedRunType }),
    });
    const result: PrepareRunIntakeResult = {
      kind: "ready",
      // Human intake may remain open indefinitely. Never retain this discovery connection across
      // the modal: the authority intentionally retires idle sockets, so Start acquires a fresh
      // connection immediately before its one mutation instead.
      session: new GuidedRunIntakeSession(options.connect, options.idempotencyKey),
      state,
    };
    connection.close();
    return result;
  } catch (error) {
    connection.close();
    throw error;
  }
}

export function createGuidedRunState(input: {
  runTypes: readonly ControlRunTypeOption[];
  defaultRunTypeId: string;
  branches: readonly RunIntakeBranch[];
  models: readonly ControlModelOption[];
  requestedRunType?: string;
}): GuidedRunState {
  if (input.runTypes.length === 0) throw new Error("project has no runnable run types");
  if (input.branches.length === 0) throw new Error("repository has no target branches");
  const requested = input.requestedRunType;
  const runTypeIndex = Math.max(
    0,
    input.runTypes.findIndex(
      (runType) =>
        runType.id === requested ||
        (requested === undefined && runType.id === input.defaultRunTypeId),
    ),
  );
  const selected = input.runTypes[runTypeIndex]!;
  const state = {
    objective: "",
    objectiveCursor: 0,
    intake: {},
    intakeText: {},
    intakeCursors: {},
    intakeOptionIndexes: {},
    runTypes: structuredClone(input.runTypes),
    runTypeIndex,
    target: createRunTargetDraft(structuredClone(input.branches)),
    models: structuredClone(input.models),
    questionPolicy: selected.questionPolicy,
    maxParallel: selected.maxParallel,
    roles: structuredClone(selected.roles),
    focus: "objective",
    scroll: 0,
    busy: false,
    error:
      requested !== undefined && !input.runTypes.some((runType) => runType.id === requested)
        ? `Run type ${requested} is unavailable; using ${selected.title}.`
        : undefined,
  } satisfies GuidedRunState;
  applyRunTypeDefaults(state, selected);
  return state;
}

export function guidedRunFocusOrder(state: GuidedRunState): readonly GuidedRunFocus[] {
  return [
    "objective",
    ...selectedAdditionalIntake(state).map((field): GuidedRunFocus => `intake:${field.id}`),
    "run_type",
    "branch",
    ...(isCreatingNewTarget(state.target) ? ["branch_name" as const] : []),
    "questions",
    "parallel",
    ...state.roles.flatMap((role): GuidedRunFocus[] => [
      `role:${role.id}:model`,
      `role:${role.id}:reasoning`,
    ]),
    "start",
  ];
}

export function moveGuidedRunFocus(state: GuidedRunState, delta: -1 | 1): GuidedRunState {
  const next = structuredClone(state);
  const order = guidedRunFocusOrder(next);
  const current = Math.max(0, order.indexOf(next.focus));
  next.focus = order[cycle(current, delta, order.length)]!;
  next.error = undefined;
  return next;
}

export function adjustGuidedRunSelection(state: GuidedRunState, delta: -1 | 1): GuidedRunState {
  const next = structuredClone(state);
  if (next.focus === "run_type") {
    next.runTypeIndex = cycle(next.runTypeIndex, delta, next.runTypes.length);
    applyRunTypeDefaults(next, next.runTypes[next.runTypeIndex]!);
  } else if (next.focus === "branch") {
    next.target = cycleRunTarget(next.target, delta);
  } else if (next.focus === "questions") {
    const values = ["none", "some", "many"] as const;
    next.questionPolicy = values[cycle(values.indexOf(next.questionPolicy), delta, values.length)]!;
  } else if (next.focus === "parallel") {
    next.maxParallel = Math.max(1, next.maxParallel + delta);
  } else if (next.focus.startsWith("intake:")) {
    adjustIntakeSelection(next, next.focus.slice("intake:".length), delta);
  } else if (next.focus.startsWith("role:")) {
    const [, roleId, column] = next.focus.split(":");
    const role = next.roles.find((candidate) => candidate.id === roleId);
    if (role === undefined) return next;
    if (column === "model") adjustRoleModel(next, role, delta);
    else adjustRoleReasoning(next, role, delta);
  }
  next.error = undefined;
  return next;
}

export function buildGuidedRunCreateInput(state: GuidedRunState): GuidedRunCreateInput {
  const runType = state.runTypes[state.runTypeIndex];
  if (runType === undefined) throw new Error("Selected run type is no longer available.");
  const intake = buildTypedIntake(state, runType);
  const objectiveValue = intake[runType.objectiveFieldId];
  const objective = typeof objectiveValue === "string" ? objectiveValue.trim() : "";
  if (objective.length === 0) throw new Error("Objective is required.");
  if ([...objective].length > 4 * 1024 * 1024) throw new Error("Objective is too large.");
  const target = resolveRunTarget(state.target);
  if (!target.ok) throw new Error(target.error);
  const roles: GuidedRunCreateInput["overrides"]["roles"] = {};
  for (const role of state.roles) {
    const model = state.models.find(
      (candidate) => candidate.provider === role.provider && candidate.id === role.model,
    );
    if (model === undefined || !model.available) {
      throw new Error(
        `${role.title}: ${role.provider}/${role.model} is unavailable to contained Koni attempts.`,
      );
    }
    if (!model.thinkingLevels.includes(role.thinkingLevel)) {
      throw new Error(
        `${role.title}: ${role.model} does not support ${role.thinkingLevel} reasoning.`,
      );
    }
    roles[role.id] = {
      provider: role.provider,
      model: role.model,
      thinkingLevel: role.thinkingLevel,
    };
  }
  return {
    objective,
    runTypeId: runType.id,
    targetRef: target.targetRef,
    ...(target.createTarget === true ? { createTarget: true } : {}),
    ...(target.baseRef === undefined ? {} : { baseRef: target.baseRef }),
    intake,
    overrides: { questionPolicy: state.questionPolicy, maxParallel: state.maxParallel, roles },
  };
}

export function parseRunIntakeBranches(value: JsonValue | undefined | unknown): RunIntakeBranch[] {
  if (!Array.isArray(value) || value.length > 200)
    throw new Error("authority returned an invalid branch list");
  const branches = value.map((entry) => {
    if (!isRecord(entry)) throw new Error("authority returned an invalid branch entry");
    const raw =
      typeof entry.ref === "string"
        ? entry.ref
        : typeof entry.name === "string"
          ? entry.name
          : undefined;
    if (raw === undefined || raw.length === 0 || raw.length > 1_024 || /[\p{Control}]/u.test(raw)) {
      throw new Error("authority branch entry has no valid reference");
    }
    const reference = raw.startsWith("refs/heads/") ? raw : `refs/heads/${raw}`;
    return { label: reference.replace(/^refs\/heads\//u, ""), reference };
  });
  if (new Set(branches.map((branch) => branch.reference)).size !== branches.length) {
    throw new Error("authority returned duplicate branch references");
  }
  return branches;
}

function applyRunTypeDefaults(state: GuidedRunState, runType: ControlRunTypeOption): void {
  state.questionPolicy = runType.questionPolicy;
  state.maxParallel = runType.maxParallel;
  state.roles = structuredClone(runType.roles);
  const previousText = state.intakeText;
  const previousValues = state.intake;
  state.intake = {};
  state.intakeText = {};
  state.intakeCursors = {};
  state.intakeOptionIndexes = {};
  for (const field of runType.intake) {
    const previous = previousValues[field.id];
    const initial = previous ?? field.default ?? initialIntakeValue(field);
    if (initial !== undefined) state.intake[field.id] = structuredClone(initial);
    const textValue = previousText[field.id] ?? editableIntakeText(initial, field);
    state.intakeText[field.id] = textValue;
    state.intakeCursors[field.id] = Array.from(textValue).length;
    state.intakeOptionIndexes[field.id] = Math.max(
      0,
      field.options.findIndex((option) => option.value === initial),
    );
  }
  const objectiveText = state.intakeText[runType.objectiveFieldId] ?? "";
  state.objective = objectiveText;
  state.objectiveCursor = state.intakeCursors[runType.objectiveFieldId] ?? 0;
}

export function guidedRunIntakeField(
  state: GuidedRunState,
  focus = state.focus,
): ControlIntakeField | undefined {
  const runType = state.runTypes[state.runTypeIndex];
  if (runType === undefined) return undefined;
  const id =
    focus === "objective"
      ? runType.objectiveFieldId
      : focus.startsWith("intake:")
        ? focus.slice("intake:".length)
        : undefined;
  return id === undefined ? undefined : runType.intake.find((field) => field.id === id);
}

export function updateGuidedRunIntakeText(
  state: GuidedRunState,
  fieldId: string,
  value: string,
  cursor: number,
): GuidedRunState {
  const next = structuredClone(state);
  next.intakeText[fieldId] = value;
  next.intakeCursors[fieldId] = Math.max(0, Math.min(Array.from(value).length, cursor));
  const runType = next.runTypes[next.runTypeIndex];
  if (runType?.objectiveFieldId === fieldId) {
    next.objective = value;
    next.objectiveCursor = next.intakeCursors[fieldId]!;
  }
  next.error = undefined;
  return next;
}

export function updateGuidedRunTargetName(
  state: GuidedRunState,
  value: string,
  cursor: number,
): GuidedRunState {
  const next = structuredClone(state);
  next.target = {
    ...next.target,
    newName: value,
    newNameCursor: Math.max(0, Math.min(Array.from(value).length, cursor)),
  };
  next.error = undefined;
  return next;
}

function selectedAdditionalIntake(state: GuidedRunState): readonly ControlIntakeField[] {
  const runType = state.runTypes[state.runTypeIndex];
  return runType?.intake.filter((field) => field.id !== runType.objectiveFieldId) ?? [];
}

function adjustIntakeSelection(state: GuidedRunState, fieldId: string, delta: -1 | 1): void {
  const field = state.runTypes[state.runTypeIndex]?.intake.find(
    (candidate) => candidate.id === fieldId,
  );
  if (field === undefined) return;
  if (field.kind === "boolean") {
    state.intake[fieldId] = !(state.intake[fieldId] === true);
  } else if (field.kind === "choice" || field.kind === "multi_choice") {
    if (field.options.length === 0) return;
    const index = cycle(state.intakeOptionIndexes[fieldId] ?? 0, delta, field.options.length);
    state.intakeOptionIndexes[fieldId] = index;
    const value = field.options[index]!.value;
    if (field.kind === "choice") state.intake[fieldId] = value;
  }
}

export function toggleGuidedRunIntakeSelection(state: GuidedRunState): GuidedRunState {
  const next = structuredClone(state);
  const field = guidedRunIntakeField(next);
  if (field === undefined) return next;
  if (field.kind === "boolean") next.intake[field.id] = !(next.intake[field.id] === true);
  if (field.kind === "multi_choice" && field.options.length > 0) {
    const value = field.options[next.intakeOptionIndexes[field.id] ?? 0]?.value;
    if (value !== undefined) {
      const current = Array.isArray(next.intake[field.id])
        ? (next.intake[field.id] as readonly ConfigurationValue[]).filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      next.intake[field.id] = current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value];
    }
  }
  next.error = undefined;
  return next;
}

function buildTypedIntake(
  state: GuidedRunState,
  runType: ControlRunTypeOption,
): ConfigurationObject {
  const output: Record<string, ConfigurationValue> = Object.create(null) as Record<
    string,
    ConfigurationValue
  >;
  for (const field of runType.intake) {
    let value: ConfigurationValue | undefined;
    if (field.kind === "string" || field.kind === "text" || field.kind === "path") {
      value =
        field.id === runType.objectiveFieldId
          ? state.objective
          : (state.intakeText[field.id] ?? "");
    } else if (field.kind === "integer" || field.kind === "number") {
      const source = (state.intakeText[field.id] ?? "").trim();
      if (source.length > 0) {
        const parsed = Number(source);
        if (!Number.isFinite(parsed) || (field.kind === "integer" && !Number.isSafeInteger(parsed)))
          throw new Error(
            `${field.label} must be ${field.kind === "integer" ? "an integer" : "a number"}.`,
          );
        value = parsed;
      }
    } else if (field.kind === "json") {
      const source = (state.intakeText[field.id] ?? "").trim();
      if (source.length > 0) {
        try {
          value = JSON.parse(source) as ConfigurationValue;
        } catch {
          throw new Error(`${field.label} must be valid JSON.`);
        }
      }
    } else {
      value = state.intake[field.id];
    }
    const empty =
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0);
    if (empty) {
      if (field.required) throw new Error(`${field.label} is required.`);
      continue;
    }
    if (value === undefined) continue;
    if (
      (field.kind === "choice" || field.kind === "multi_choice") &&
      !choiceValueAllowed(field, value)
    )
      throw new Error(`${field.label} contains an unavailable option.`);
    output[field.id] = structuredClone(value);
  }
  return output;
}

function choiceValueAllowed(field: ControlIntakeField, value: ConfigurationValue): boolean {
  if (field.kind === "choice")
    return typeof value === "string" && field.options.some((option) => option.value === value);
  return (
    Array.isArray(value) &&
    value.every(
      (item) => typeof item === "string" && field.options.some((option) => option.value === item),
    )
  );
}

function initialIntakeValue(field: ControlIntakeField): ConfigurationValue | undefined {
  if (field.kind === "boolean") return false;
  if (field.kind === "choice") return field.options[0]?.value;
  if (field.kind === "multi_choice") return [];
  return undefined;
}

function editableIntakeText(
  value: ConfigurationValue | undefined,
  field: ControlIntakeField,
): string {
  if (value === undefined || value === null) return "";
  if (field.kind === "json") return JSON.stringify(value, null, 2);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function adjustRoleModel(state: GuidedRunState, role: GuidedRunRoleSelection, delta: -1 | 1): void {
  const selectable = state.models.filter((model) => model.available);
  if (selectable.length === 0) return;
  const current = Math.max(
    0,
    selectable.findIndex((model) => model.provider === role.provider && model.id === role.model),
  );
  const selected = selectable[cycle(current, delta, selectable.length)]!;
  role.provider = selected.provider;
  role.model = selected.id;
  if (!selected.thinkingLevels.includes(role.thinkingLevel)) {
    role.thinkingLevel = nearestThinkingLevel(selected.thinkingLevels, role.thinkingLevel);
  }
}

function adjustRoleReasoning(
  state: GuidedRunState,
  role: GuidedRunRoleSelection,
  delta: -1 | 1,
): void {
  const model = state.models.find(
    (candidate) => candidate.provider === role.provider && candidate.id === role.model,
  );
  if (model === undefined || model.thinkingLevels.length === 0) return;
  const current = Math.max(0, model.thinkingLevels.indexOf(role.thinkingLevel));
  role.thinkingLevel = model.thinkingLevels[cycle(current, delta, model.thinkingLevels.length)]!;
}

function nearestThinkingLevel(
  supported: readonly ControlThinkingLevel[],
  current: ControlThinkingLevel,
): ControlThinkingLevel {
  if (supported.length === 0) return current;
  const order: readonly ControlThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  const position = order.indexOf(current);
  return [...supported].sort(
    (left, right) =>
      Math.abs(order.indexOf(left) - position) - Math.abs(order.indexOf(right) - position),
  )[0]!;
}

function cycle(index: number, delta: number, length: number): number {
  return length <= 0 ? 0 : (index + delta + length) % length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
