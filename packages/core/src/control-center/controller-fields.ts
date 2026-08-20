import type { JsonValue } from "../authority/protocol.js";
import type { GraphEdge, GraphNode } from "../graph/model.js";
import type {
  StageActionCapability,
  StageActionFieldSchema,
  StageActionValue,
} from "../state/stage-capability.js";
import {
  THINKING_LEVELS,
  type ControlModelOption,
  type ControlProfileConflictCatalog,
} from "./protocol.js";
import type { TranscriptBlock } from "./transcript.js";
import type { QuestionView } from "./view-model.js";

interface SavedQuestionDraft {
  selectedOptionId: string | undefined;
  notes: string;
}

export function cloneModal<T>(modal: T): T {
  return structuredClone(modal);
}

export function questionDraftMatchesSaved(
  question: QuestionView,
  draft: SavedQuestionDraft,
): boolean {
  return (
    draft.selectedOptionId === question.savedSelectedOptionId &&
    draft.notes.trim() === (question.savedNotes ?? "").trim()
  );
}

export function initialActionFieldValue(field: StageActionFieldSchema): StageActionValue {
  const defined = field.lockedValue ?? field.defaultValue;
  if (defined !== undefined) return structuredClone(defined);
  if (field.kind === "boolean") return false;
  if (field.kind === "integer" || field.kind === "number") return field.minimum ?? 0;
  if (field.kind === "string_list") return [];
  if (field.kind === "select") return field.options?.[0]?.value ?? "";
  return "";
}

export function actionFieldValues(action: StageActionCapability): Record<string, StageActionValue> {
  return Object.fromEntries(
    (action.form?.fields ?? []).map((field) => [field.key, initialActionFieldValue(field)]),
  );
}

export function isTextActionField(field: StageActionFieldSchema): boolean {
  return field.kind === "text" || field.kind === "multiline" || field.kind === "string_list";
}

export function actionFieldText(
  field: StageActionFieldSchema | undefined,
  values: Readonly<Record<string, StageActionValue>>,
): string {
  if (field === undefined) return "";
  const value = values[field.key];
  if (Array.isArray(value)) return value.join("\n");
  return typeof value === "string" ? value : value === undefined ? "" : String(value);
}

export function setActionFieldText(
  field: StageActionFieldSchema,
  values: Record<string, StageActionValue>,
  value: string,
): void {
  values[field.key] = field.kind === "string_list" ? value.split("\n") : value;
}

export function cycleActionFieldValue(
  field: StageActionFieldSchema,
  values: Record<string, StageActionValue>,
  delta: -1 | 1,
): void {
  if (field.kind === "boolean") {
    values[field.key] = values[field.key] !== true;
    return;
  }
  if (field.kind === "select") {
    const options = field.options?.map((option) => option.value) ?? [];
    if (options.length > 0)
      values[field.key] = moveOptionalString(options, String(values[field.key] ?? ""), delta);
    return;
  }
  if (field.kind === "integer" || field.kind === "number") {
    const current =
      typeof values[field.key] === "number" ? (values[field.key] as number) : (field.minimum ?? 0);
    const minimum =
      field.minimum ?? (field.kind === "integer" ? Number.MIN_SAFE_INTEGER : -Number.MAX_VALUE);
    const maximum =
      field.maximum ?? (field.kind === "integer" ? Number.MAX_SAFE_INTEGER : Number.MAX_VALUE);
    values[field.key] = Math.min(maximum, Math.max(minimum, current + delta));
  }
}

export function normalizeModels(models: readonly ControlModelOption[]): ControlModelOption[] {
  const seen = new Set<string>();
  return models
    .filter((model) => {
      const key = `${model.provider}/${model.id}`;
      if (seen.has(key) || model.provider.trim().length === 0 || model.id.trim().length === 0)
        return false;
      seen.add(key);
      return true;
    })
    .map((model) => ({
      ...model,
      thinkingLevels: THINKING_LEVELS.filter((level) => model.thinkingLevels.includes(level)),
    }))
    .sort(
      (left, right) =>
        Number(right.available) - Number(left.available) ||
        left.provider.localeCompare(right.provider) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
}

export function selectableModels(
  models: readonly ControlModelOption[],
  currentProvider: string,
  currentModel: string,
): Array<Pick<ControlModelOption, "provider" | "id" | "thinkingLevels">> {
  const available = models.filter((model) => model.available);
  const current = models.find(
    (model) => model.provider === currentProvider && model.id === currentModel,
  );
  if (available.length > 0) return [...available];
  // Keep a configured unavailable value visible when no executable alternative exists, but there
  // is no cycle that can select any other unavailable catalog entry.
  if (current !== undefined) return [current];
  return currentProvider.length > 0 && currentModel.length > 0
    ? [{ provider: currentProvider, id: currentModel, thinkingLevels: [] }]
    : [];
}

export function moveOptionalString<T extends string>(
  values: readonly T[],
  selected: string,
  delta: -1 | 1,
): T {
  if (values.length === 0) throw new Error("cannot move through an empty selection");
  const index = values.indexOf(selected as T);
  if (index < 0) return values[delta > 0 ? 0 : values.length - 1]!;
  return values[cycleIndex(index, values.length, delta)]!;
}

export function selectableModelsForConfig(
  models: readonly ControlModelOption[],
  current: string | undefined,
): Array<Pick<ControlModelOption, "provider" | "id" | "thinkingLevels">> {
  if (models.length === 0) return [];
  const split = current?.indexOf("/") ?? -1;
  const provider = split < 0 ? undefined : current!.slice(0, split);
  const id = split < 0 ? undefined : current!.slice(split + 1);
  if (provider === undefined || id === undefined) return selectableModels(models, "", "");
  return selectableModels(models, provider, id);
}

export function configuredModel(
  models: readonly ControlModelOption[],
  value: string,
): ControlModelOption | undefined {
  const split = value.indexOf("/");
  if (split < 0) return undefined;
  return models.find(
    (model) => model.provider === value.slice(0, split) && model.id === value.slice(split + 1),
  );
}

export function moveSelection<T>(
  values: readonly T[],
  selected: T | undefined,
  delta: -1 | 1,
): T | undefined {
  if (values.length === 0) return undefined;
  const index = selected === undefined ? (delta > 0 ? -1 : 0) : values.indexOf(selected);
  return values[(Math.max(-1, index) + delta + values.length) % values.length];
}

export function moveString<T extends string>(
  values: readonly T[],
  selected: string,
  delta: -1 | 1,
): T {
  if (values.length === 0) throw new Error("cannot move through an empty selection");
  const index = Math.max(0, values.indexOf(selected as T));
  return values[cycleIndex(index, values.length, delta)]!;
}

export function cycleIndex(index: number, length: number, delta: -1 | 1): number {
  return length <= 0 ? 0 : (Math.max(0, index) + delta + length) % length;
}

export function parseGraph(value: unknown): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const root = asRecord(value);
  if (root === undefined || !Array.isArray(root.nodes) || !Array.isArray(root.edges))
    throw new Error("authority returned an invalid graph projection");
  return {
    nodes: root.nodes.map((node) => {
      const row = asRecord(node);
      if (
        typeof row?.id !== "string" ||
        typeof row.type !== "string" ||
        typeof row.title !== "string"
      )
        throw new Error("authority returned an invalid graph node");
      return row as unknown as GraphNode;
    }),
    edges: root.edges.map((edge) => {
      const row = asRecord(edge);
      if (
        typeof row?.source !== "string" ||
        typeof row.relation !== "string" ||
        typeof row.target !== "string"
      )
        throw new Error("authority returned an invalid graph edge");
      return row as unknown as GraphEdge;
    }),
  };
}

export function cloneTranscriptBlock(block: TranscriptBlock): TranscriptBlock {
  return {
    ...block,
    ...(block.chunk === undefined ? {} : { chunk: { ...block.chunk } }),
  };
}

export function emptyProfileConflictCatalog(): ControlProfileConflictCatalog {
  return {
    protocol: "koni.profile-upstream-conflict-catalog.v1",
    lifecycleGeneration: 0,
    profileVersion: "Unavailable",
    conflicts: [],
  };
}

export function conciseOperatorReason(value: string): string {
  const safe = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\b(?:sha256:)?[a-f0-9]{40,64}\b/giu, "[digest]")
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gu, "[local checkout]")
    .replace(/(^|[\s(])\/(?:[^\s/]+\/)*[^\s,;:)]*/gu, "$1[local checkout]")
    .replace(/(?:\.\.?\/)[^\s,;:)]+/gu, "[local checkout]")
    .replace(/\s+/gu, " ")
    .trim();
  const words = safe.split(/\s+/u);
  return words.length > 24 ? `${words.slice(0, 24).join(" ")}…` : safe;
}

export function shortBranchForOperator(reference: string): string {
  return reference.replace(/^refs\/heads\//u, "");
}

export function titleCaseForOperator(value: string): string {
  return value.replace(/[-_]+/gu, " ").replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function removeLastCharacter(value: string): string {
  return Array.from(value).slice(0, -1).join("");
}

export function characterCount(value: string): number {
  return Array.from(value).length;
}

export function clampCharacterOffset(value: string, offset: number): number {
  return Math.max(0, Math.min(characterCount(value), offset));
}

export function insertAtCharacter(value: string, offset: number, inserted: string): string {
  const characters = Array.from(value);
  characters.splice(clampCharacterOffset(value, offset), 0, inserted);
  return characters.join("");
}

export function insertBoundedAtCharacter(
  value: string,
  offset: number,
  inserted: string,
  maximumCharacters: number,
): { value: string; cursor: number } {
  const characters = Array.from(value);
  const cursor = clampCharacterOffset(value, offset);
  const admitted = Array.from(inserted).slice(
    0,
    Math.max(0, maximumCharacters - characters.length),
  );
  characters.splice(cursor, 0, ...admitted);
  return { value: characters.join(""), cursor: cursor + admitted.length };
}

export function removeCharacterBefore(
  value: string,
  offset: number,
): { value: string; cursor: number } {
  const characters = Array.from(value);
  const cursor = clampCharacterOffset(value, offset);
  if (cursor === 0) return { value, cursor };
  characters.splice(cursor - 1, 1);
  return { value: characters.join(""), cursor: cursor - 1 };
}

export function removeCharacterAt(value: string, offset: number): string {
  const characters = Array.from(value);
  const cursor = clampCharacterOffset(value, offset);
  if (cursor < characters.length) characters.splice(cursor, 1);
  return characters.join("");
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function rebaseConfigValues(
  base: Readonly<Record<string, JsonValue>>,
  draft: Readonly<Record<string, JsonValue>>,
  current: Readonly<Record<string, JsonValue>>,
): { values: Record<string, JsonValue>; conflicts: number } {
  const values: Record<string, JsonValue> = {};
  let conflicts = 0;
  for (const [key, currentValue] of Object.entries(current)) {
    const baseValue = base[key];
    const draftValue = draft[key];
    const locallyEdited = draftValue !== undefined && !jsonEqual(draftValue, baseValue);
    if (!locallyEdited) {
      values[key] = structuredClone(currentValue);
      continue;
    }
    if (!jsonEqual(currentValue, baseValue) && !jsonEqual(currentValue, draftValue)) conflicts += 1;
    values[key] = structuredClone(draftValue);
  }
  return { values, conflicts };
}
