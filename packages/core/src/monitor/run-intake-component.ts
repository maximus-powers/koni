import type { Component, Focusable } from "@earendil-works/pi-tui";
import {
  decodeKittyPrintable,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ControlIntakeField, ControlThinkingLevel } from "../control-center/protocol.js";
import {
  isCreatingNewTarget,
  runTargetSelectedLabel,
  validateNewBranchName,
} from "../control-center/run-target.js";
import { plainMonitorPalette, type MonitorPalette } from "./presentation.js";
import {
  adjustGuidedRunSelection,
  buildGuidedRunCreateInput,
  guidedRunIntakeField,
  moveGuidedRunFocus,
  toggleGuidedRunIntakeSelection,
  updateGuidedRunIntakeText,
  updateGuidedRunTargetName,
  type GuidedRunFocus,
  type GuidedRunState,
} from "./run-intake.js";
import { fitTerminalLine, terminalSafeLines, terminalSafeText } from "./terminal.js";

export type GuidedRunModalResult =
  { kind: "cancel" } | { kind: "started"; runId: string; warning?: string; state: GuidedRunState };

export interface GuidedRunModalComponentOptions {
  state: GuidedRunState;
  create: (state: GuidedRunState) => Promise<{ runId: string; warning?: string }>;
  done: (result: GuidedRunModalResult) => void;
  palette?: MonitorPalette;
  viewportRows?: () => number;
  requestRender?: () => void;
}

/**
 * Complete guided `/koni-run` intake. Submission drives the injected `create` callback while the
 * modal stays open; it closes only once creation succeeds or the operator cancels, so a rejected
 * submission keeps every entered value editable for retry.
 */
export class GuidedRunModalComponent implements Component, Focusable {
  public focused = false;
  readonly #create: (state: GuidedRunState) => Promise<{ runId: string; warning?: string }>;
  readonly #done: (result: GuidedRunModalResult) => void;
  readonly #palette: MonitorPalette;
  readonly #viewportRows: () => number;
  readonly #requestRender: (() => void) | undefined;
  #state: GuidedRunState;
  #closed = false;
  #followFocus = true;

  public constructor(options: GuidedRunModalComponentOptions) {
    this.#state = structuredClone(options.state);
    this.#create = options.create;
    this.#done = options.done;
    this.#palette = options.palette ?? plainMonitorPalette;
    this.#viewportRows = options.viewportRows ?? (() => 42);
    this.#requestRender = options.requestRender;
  }

  public get state(): GuidedRunState {
    return structuredClone(this.#state);
  }

  public invalidate(): void {}

  public handleInput(data: string): void {
    // Busy means a creation request is in flight; the request cannot be aborted, so every key
    // (including Escape) waits for the settled response, server rejection, or socket close.
    if (this.#closed || this.#state.busy) return;
    if (matchesKey(data, Key.escape)) {
      this.#closed = true;
      this.#done({ kind: "cancel" });
      return;
    }
    const intakeField = guidedRunIntakeField(this.#state);
    if (intakeField !== undefined && isTextEditableIntake(intakeField.kind)) {
      const fieldId = intakeField.id;
      const value = this.#state.intakeText[fieldId] ?? "";
      const cursor = this.#state.intakeCursors[fieldId] ?? 0;
      const paste = bracketedPaste(data);
      if (matchesKey(data, Key.tab)) {
        this.#state = moveGuidedRunFocus(this.#state, 1);
        this.#followFocus = true;
      } else if (matchesKey(data, Key.shift(Key.tab))) {
        this.#state = moveGuidedRunFocus(this.#state, -1);
        this.#followFocus = true;
      } else if (matchesKey(data, Key.left)) {
        this.#state = updateGuidedRunIntakeText(
          this.#state,
          fieldId,
          value,
          clampCharacterOffset(value, cursor - 1),
        );
        this.#followFocus = true;
      } else if (matchesKey(data, Key.right)) {
        this.#state = updateGuidedRunIntakeText(
          this.#state,
          fieldId,
          value,
          clampCharacterOffset(value, cursor + 1),
        );
        this.#followFocus = true;
      } else if (matchesKey(data, Key.home)) {
        this.#state = updateGuidedRunIntakeText(this.#state, fieldId, value, 0);
        this.#followFocus = true;
      } else if (matchesKey(data, Key.end)) {
        this.#state = updateGuidedRunIntakeText(this.#state, fieldId, value, characterCount(value));
        this.#followFocus = true;
      } else if (matchesKey(data, Key.backspace)) {
        const edit = removeCharacterBefore(value, cursor);
        this.#state = updateGuidedRunIntakeText(this.#state, fieldId, edit.value, edit.cursor);
        this.#followFocus = true;
      } else if (matchesKey(data, Key.delete)) {
        this.#state = updateGuidedRunIntakeText(
          this.#state,
          fieldId,
          removeCharacterAt(value, cursor),
          cursor,
        );
        this.#followFocus = true;
      } else if (
        matchesKey(data, Key.enter) ||
        matchesKey(data, Key.shift(Key.enter)) ||
        matchesKey(data, Key.alt(Key.enter))
      ) {
        if (intakeField.kind === "text" || intakeField.kind === "json") {
          const edit = insertBoundedAtCharacter(value, cursor, "\n", 4 * 1024 * 1024);
          this.#state = updateGuidedRunIntakeText(this.#state, fieldId, edit.value, edit.cursor);
        } else {
          this.#state = moveGuidedRunFocus(this.#state, 1);
        }
        this.#followFocus = true;
      } else {
        const printable = paste ?? printableInput(data);
        if (printable !== undefined) {
          const edit = insertBoundedAtCharacter(value, cursor, printable, 4 * 1024 * 1024);
          this.#state = updateGuidedRunIntakeText(this.#state, fieldId, edit.value, edit.cursor);
          this.#followFocus = true;
        }
      }
      this.#state.error = undefined;
      this.#requestRender?.();
      return;
    }
    if (this.#state.focus === "branch_name") {
      const value = this.#state.target.newName;
      const cursor = this.#state.target.newNameCursor;
      const paste = bracketedPaste(data);
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
        this.#state = moveGuidedRunFocus(this.#state, 1);
        this.#followFocus = true;
      } else if (matchesKey(data, Key.shift(Key.tab)) || matchesKey(data, Key.up)) {
        this.#state = moveGuidedRunFocus(this.#state, -1);
        this.#followFocus = true;
      } else if (matchesKey(data, Key.left)) {
        this.#state = updateGuidedRunTargetName(
          this.#state,
          value,
          clampCharacterOffset(value, cursor - 1),
        );
      } else if (matchesKey(data, Key.right)) {
        this.#state = updateGuidedRunTargetName(
          this.#state,
          value,
          clampCharacterOffset(value, cursor + 1),
        );
      } else if (matchesKey(data, Key.home)) {
        this.#state = updateGuidedRunTargetName(this.#state, value, 0);
      } else if (matchesKey(data, Key.end)) {
        this.#state = updateGuidedRunTargetName(this.#state, value, characterCount(value));
      } else if (matchesKey(data, Key.backspace)) {
        const edit = removeCharacterBefore(value, cursor);
        this.#state = updateGuidedRunTargetName(this.#state, edit.value, edit.cursor);
      } else if (matchesKey(data, Key.delete)) {
        this.#state = updateGuidedRunTargetName(
          this.#state,
          removeCharacterAt(value, cursor),
          cursor,
        );
      } else if (matchesKey(data, Key.enter)) {
        this.#state = moveGuidedRunFocus(this.#state, 1);
        this.#followFocus = true;
      } else {
        const printable = paste ?? printableInput(data);
        if (printable !== undefined) {
          const edit = insertBoundedAtCharacter(value, cursor, printable, 200);
          this.#state = updateGuidedRunTargetName(this.#state, edit.value, edit.cursor);
        }
      }
      this.#requestRender?.();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
      this.#state = moveGuidedRunFocus(this.#state, 1);
      this.#followFocus = true;
    } else if (matchesKey(data, Key.shift(Key.tab)) || matchesKey(data, Key.up)) {
      this.#state = moveGuidedRunFocus(this.#state, -1);
      this.#followFocus = true;
    } else if (matchesKey(data, Key.left) || data === "[") {
      this.#state = adjustGuidedRunSelection(this.#state, -1);
      this.#followFocus = true;
    } else if (matchesKey(data, Key.right) || data === "]") {
      this.#state = adjustGuidedRunSelection(this.#state, 1);
      this.#followFocus = true;
    } else if (matchesKey(data, Key.pageUp)) {
      this.#state.scroll = Math.max(0, this.#state.scroll - 8);
      this.#followFocus = false;
    } else if (matchesKey(data, Key.pageDown)) {
      this.#state.scroll += 8;
      this.#followFocus = false;
    } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl(Key.enter))) {
      if (this.#state.focus === "start") void this.#submit();
      else if (
        guidedRunIntakeField(this.#state)?.kind === "multi_choice" ||
        guidedRunIntakeField(this.#state)?.kind === "boolean"
      )
        this.#state = toggleGuidedRunIntakeSelection(this.#state);
      else this.#state = adjustGuidedRunSelection(this.#state, 1);
    }
    this.#requestRender?.();
  }

  public render(width: number): string[] {
    const safeWidth = Math.max(28, Math.floor(width));
    const height = Math.max(14, this.#viewportRows());
    const inner = safeWidth - 2;
    const body = this.#body(inner);
    const bodyCapacity = Math.max(7, height - 4);
    const maximumScroll = Math.max(0, body.lines.length - bodyCapacity);
    this.#state.scroll = Math.min(this.#state.scroll, maximumScroll);
    if (this.#followFocus) {
      this.#state.scroll = focusFollowingScroll(
        this.#state.scroll,
        maximumScroll,
        bodyCapacity,
        body.focusLine,
      );
      this.#followFocus = false;
    }
    const visible = body.lines.slice(this.#state.scroll, this.#state.scroll + bodyCapacity);
    if (this.#state.scroll > 0 && visible.length > 0) visible[0] = this.#palette.dim("↑ more");
    if (this.#state.scroll < maximumScroll && visible.length > 0)
      visible[visible.length - 1] = this.#palette.dim("↓ more");
    const title = "New Koni Run";
    const lines = [
      `${this.#palette.border("┌")} ${this.#palette.bold(this.#palette.accent(title))}${this.#palette.border("─".repeat(Math.max(0, inner - visibleWidth(title) - 1)))}${this.#palette.border("┐")}`,
      ...visible,
      this.#palette.muted(
        "Tab/↑/↓ focus · ←/→ choose · Enter edit/start · PgUp/PgDn scroll · Esc close",
      ),
      this.#palette.border(`└${"─".repeat(inner)}┘`),
    ];
    while (lines.length < height) lines.splice(lines.length - 2, 0, "");
    return lines.slice(0, height).map((line, index) => {
      if (index === 0 || index === height - 1) return fitTerminalLine(line, safeWidth);
      return `${this.#palette.border("│")}${fitTerminalLine(line, inner, true)}${this.#palette.border("│")}`;
    });
  }

  #body(width: number): { lines: string[]; focusLine: number } {
    const selectedType = this.#state.runTypes[this.#state.runTypeIndex]!;
    const focusLines = new Map<GuidedRunFocus, number>();
    const lines: string[] = [sectionLabel("Goal Prompt", width, this.#palette)];
    const objective = objectiveEditorLines(this.#state, Math.max(1, width - 2));
    const objectiveStart = lines.length;
    lines.push(
      ...objective.lines.map((line) =>
        this.#state.objective.length === 0 && this.#state.focus !== "objective"
          ? this.#palette.dim(` ${line}`)
          : ` ${line}`,
      ),
    );
    focusLines.set("objective", objectiveStart + objective.caretLine);
    for (const field of selectedType.intake.filter(
      (candidate) => candidate.id !== selectedType.objectiveFieldId,
    )) {
      lines.push("", this.#palette.muted(`${field.label}${field.required ? " *" : ""}`));
      if (field.description.length > 0)
        lines.push(
          ...terminalSafeLines(field.description, width, { maxCodePoints: 1_024, maxLines: 3 }).map(
            (line) => this.#palette.dim(line),
          ),
        );
      const focus: GuidedRunFocus = `intake:${field.id}`;
      focusLines.set(focus, lines.length);
      lines.push(...intakeFieldLines(this.#state, field, width, this.#palette));
    }
    lines.push("", sectionLabel("Run Config", width, this.#palette), "");

    lines.push(this.#palette.muted("Run type"));
    focusLines.set("run_type", lines.length);
    lines.push(
      this.#state.runTypes
        .map((runType, index) =>
          selector(
            runType.title,
            this.#state.focus === "run_type" && index === this.#state.runTypeIndex,
            index === this.#state.runTypeIndex,
            this.#palette,
          ),
        )
        .join("  "),
    );
    lines.push("", this.#palette.muted("Target branch"));
    focusLines.set("branch", lines.length);
    lines.push(
      selector(
        runTargetSelectedLabel(this.#state.target),
        this.#state.focus === "branch",
        true,
        this.#palette,
      ),
    );
    if (isCreatingNewTarget(this.#state.target)) {
      lines.push(
        this.#palette.dim("Branches a new target from the current branch before the run starts."),
      );
      lines.push(this.#palette.muted("New branch name"));
      focusLines.set("branch_name", lines.length);
      const name = this.#state.target.newName;
      const focused = this.#state.focus === "branch_name";
      const shown = name.length === 0 ? "(type a branch name)" : name;
      lines.push(
        focused
          ? this.#palette.accent(`› ${shown}▏`)
          : name.length === 0
            ? this.#palette.dim(`  ${shown}`)
            : `  ${shown}`,
      );
      const invalid =
        name.trim().length > 0
          ? validateNewBranchName(name, this.#state.target.branches)
          : undefined;
      if (invalid !== undefined) lines.push(this.#palette.dim(invalid));
    }
    lines.push("", this.#palette.muted("Stages"));
    selectedType.stages.forEach((stage, index) => {
      const connector = index === selectedType.stages.length - 1 ? " " : "↓";
      lines.push(
        stage.included
          ? this.#palette.accent(`● ${stage.title}`)
          : this.#palette.dim(`○ ${stage.title}  skipped`),
      );
      if (connector.trim().length > 0) lines.push(this.#palette.dim(connector));
    });
    lines.push("", this.#palette.muted("Questions"));
    focusLines.set("questions", lines.length);
    lines.push(
      (["none", "some", "many"] as const)
        .map((value) =>
          selector(
            value === "none" ? "no" : value,
            this.#state.focus === "questions" && this.#state.questionPolicy === value,
            this.#state.questionPolicy === value,
            this.#palette,
            value === "none" ? "error" : value === "some" ? "warning" : "success",
          ),
        )
        .join("  "),
    );
    lines.push("");
    focusLines.set("parallel", lines.length);
    lines.push(
      `${this.#palette.muted("Max parallel agents")}  ${selector(String(this.#state.maxParallel), this.#state.focus === "parallel", true, this.#palette)}`,
    );
    lines.push(
      "",
      `${this.#palette.muted("Agent")}  ${this.#palette.muted("Model")}  ${this.#palette.muted("Reasoning")}`,
    );
    this.#state.roles.forEach((role) => {
      const modelFocused = this.#state.focus === `role:${role.id}:model`;
      const reasoningFocused = this.#state.focus === `role:${role.id}:reasoning`;
      const line = lines.length;
      focusLines.set(`role:${role.id}:model`, line);
      focusLines.set(`role:${role.id}:reasoning`, line);
      lines.push(
        `${this.#palette.text(role.title)}  ${modelSelector(role.model, modelFocused, this.#palette)}  ${reasoningSelector(role.thinkingLevel, reasoningFocused, this.#palette)}`,
      );
    });
    if (this.#state.modelNotice !== undefined) {
      lines.push(this.#palette.warning(this.#state.modelNotice));
    }
    lines.push("");
    focusLines.set("start", lines.length);
    if (this.#state.busy) {
      lines.push(this.#palette.dim(" Starting… "));
    } else {
      lines.push(
        this.#state.focus === "start"
          ? this.#palette.selected(
              ` ${selectedType.startMode === "planning" ? "Start Planning" : "Start Work"} `,
            )
          : this.#palette.accent(
              `[ ${selectedType.startMode === "planning" ? "Start Planning" : "Start Work"} ]`,
            ),
      );
    }
    if (this.#state.error !== undefined) {
      // A submission failure renders one row below the button; anchor focus-following on the error
      // row so the freshly appeared message is never clipped by the bottom scroll margin.
      if (this.#state.focus === "start") focusLines.set("start", lines.length);
      lines.push(this.#palette.error(this.#state.error));
    }
    return {
      lines: lines.map((line) => truncateToWidth(line, width, "…", true)),
      focusLine: focusLines.get(this.#state.focus) ?? 0,
    };
  }

  async #submit(): Promise<void> {
    try {
      buildGuidedRunCreateInput(this.#state);
    } catch (error) {
      this.#state.error = terminalSafeText(error instanceof Error ? error.message : String(error), {
        maxCodePoints: 256,
      });
      this.#requestRender?.();
      return;
    }
    this.#state.busy = true;
    this.#state.error = undefined;
    this.#requestRender?.();
    try {
      const created = await this.#create(structuredClone(this.#state));
      this.#state.busy = false;
      this.#closed = true;
      this.#done({
        kind: "started",
        runId: created.runId,
        ...(created.warning === undefined ? {} : { warning: created.warning }),
        state: structuredClone(this.#state),
      });
    } catch (error) {
      this.#state.busy = false;
      this.#state.error = terminalSafeText(error instanceof Error ? error.message : String(error), {
        maxCodePoints: 256,
      });
      this.#followFocus = true;
      this.#requestRender?.();
    }
  }
}

function selector(
  label: string,
  focused: boolean,
  active: boolean,
  palette: MonitorPalette,
  color: "accent" | "success" | "warning" | "error" = "accent",
): string {
  const safe = terminalSafeText(label, { maxCodePoints: 128 });
  // Distinct glyphs per state so focus and selection stay legible without color: the previous
  // bracket-drop-on-focus convention was invisible in monochrome and inverted expectations.
  if (focused) return palette.selected(`▸ ${safe} ◂`);
  if (active) return palette[color](`[• ${safe} ]`);
  return palette.dim(`[ ${safe} ]`);
}

function isTextEditableIntake(kind: ControlIntakeField["kind"]): boolean {
  return (
    kind === "string" ||
    kind === "text" ||
    kind === "path" ||
    kind === "integer" ||
    kind === "number" ||
    kind === "json"
  );
}

function intakeFieldLines(
  state: GuidedRunState,
  field: ControlIntakeField,
  width: number,
  palette: MonitorPalette,
): string[] {
  const focused = state.focus === `intake:${field.id}`;
  if (field.kind === "boolean") {
    const active = state.intake[field.id] === true;
    return [
      [false, true]
        .map((value) =>
          selector(value ? "yes" : "no", focused && active === value, active === value, palette),
        )
        .join("  "),
    ];
  }
  if (field.kind === "choice" || field.kind === "multi_choice") {
    const selected =
      field.kind === "choice"
        ? new Set(
            typeof state.intake[field.id] === "string" ? [state.intake[field.id] as string] : [],
          )
        : new Set(
            Array.isArray(state.intake[field.id])
              ? (state.intake[field.id] as readonly unknown[]).filter(
                  (item): item is string => typeof item === "string",
                )
              : [],
          );
    const index = state.intakeOptionIndexes[field.id] ?? 0;
    const lines = field.options.flatMap((option, optionIndex) => {
      const badge = selector(
        `${field.kind === "multi_choice" ? (selected.has(option.value) ? "✓ " : "□ ") : ""}${option.label}`,
        focused && index === optionIndex,
        selected.has(option.value),
        palette,
      );
      return option.description === undefined || option.description.length === 0
        ? [badge]
        : [
            badge,
            ...terminalSafeLines(option.description, Math.max(1, width - 2), {
              maxCodePoints: 1_024,
              maxLines: 3,
            }).map((line) => `  ${palette.dim(line)}`),
          ];
    });
    if (field.kind === "multi_choice")
      lines.push(palette.muted("←/→ choose option · Enter toggles"));
    return lines;
  }
  const source = state.intakeText[field.id] ?? "";
  const cursor = state.intakeCursors[field.id] ?? 0;
  const display = focused
    ? `${Array.from(source).slice(0, cursor).join("")}▌${Array.from(source).slice(cursor).join("")}`
    : source.length === 0
      ? "Enter a value…"
      : source;
  return terminalSafeLines(display, Math.max(1, width - 1), {
    maxCodePoints: 32_768,
    maxLines: field.kind === "text" || field.kind === "json" ? 8 : 2,
  }).map((line) =>
    focused
      ? palette.selected(` ${line}`)
      : source.length === 0
        ? palette.dim(` ${line}`)
        : ` ${line}`,
  );
}

function modelSelector(model: string, focused: boolean, palette: MonitorPalette): string {
  const colors = [palette.accent, palette.success, palette.warning, palette.error] as const;
  const hash = [...model].reduce((sum, point) => sum + point.codePointAt(0)!, 0);
  const styled = colors[hash % colors.length]!(
    `[ ${terminalSafeText(model, { maxCodePoints: 128 })} ]`,
  );
  return focused
    ? palette.selected(` ${terminalSafeText(model, { maxCodePoints: 128 })} `)
    : styled;
}

function reasoningSelector(
  level: ControlThinkingLevel,
  focused: boolean,
  palette: MonitorPalette,
): string {
  if (focused) return palette.selected(` ${level} `);
  switch (level) {
    case "off":
      return palette.dim(`[ ${level} ]`);
    case "minimal":
      return palette.muted(`[ ${level} ]`);
    case "low":
      return palette.success(`[ ${level} ]`);
    case "medium":
      return palette.accent(`[ ${level} ]`);
    case "high":
      return palette.warning(`[ ${level} ]`);
    case "xhigh":
    case "max":
      return palette.error(`[ ${level} ]`);
  }
}

function sectionLabel(label: string, width: number, palette: MonitorPalette): string {
  const safe = terminalSafeText(label, { maxCodePoints: 80 });
  const remaining = Math.max(0, width - visibleWidth(safe) - 2);
  const left = Math.floor(remaining / 2);
  return `${palette.border("─".repeat(left))} ${palette.muted(safe)} ${palette.border("─".repeat(remaining - left))}`;
}

function objectiveEditorLines(
  state: GuidedRunState,
  width: number,
): { lines: string[]; caretLine: number } {
  if (state.focus !== "objective") {
    const value = state.objective.length === 0 ? "Describe the outcome…" : state.objective;
    return {
      lines: terminalSafeLines(value, width, { maxCodePoints: 32_768, maxLines: 8 }),
      caretLine: 0,
    };
  }
  const characters = Array.from(state.objective);
  const cursor = clampCharacterOffset(state.objective, state.objectiveCursor);
  const context = Math.max(256, width * 12);
  const start = Math.max(0, cursor - context);
  const end = Math.min(characters.length, cursor + context);
  const source = `${start > 0 ? "…" : ""}${characters.slice(start, cursor).join("")}▌${characters.slice(cursor, end).join("")}${end < characters.length ? "…" : ""}`;
  const wrapped = terminalSafeLines(source, width, { maxCodePoints: 32_768, maxLines: 1_000 });
  const caret = Math.max(
    0,
    wrapped.findIndex((line) => line.includes("▌")),
  );
  const windowStart = Math.min(Math.max(0, caret - 7), Math.max(0, wrapped.length - 8));
  const lines = wrapped.slice(windowStart, windowStart + 8);
  return { lines, caretLine: Math.max(0, caret - windowStart) };
}

function focusFollowingScroll(
  current: number,
  maximum: number,
  capacity: number,
  focusLine: number,
): number {
  let next = Math.max(0, Math.min(current, maximum));
  const topMargin = next > 0 ? 1 : 0;
  if (focusLine < next + topMargin) next = Math.max(0, focusLine - 1);
  const hasLowerOverflow = next < maximum;
  const bottomMargin = hasLowerOverflow ? 1 : 0;
  if (focusLine > next + capacity - 1 - bottomMargin) {
    next = Math.min(maximum, Math.max(0, focusLine - capacity + 1 + bottomMargin));
  }
  return next;
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function clampCharacterOffset(value: string, offset: number): number {
  return Math.max(0, Math.min(characterCount(value), offset));
}

function insertBoundedAtCharacter(
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

function removeCharacterBefore(value: string, offset: number): { value: string; cursor: number } {
  const characters = Array.from(value);
  const cursor = clampCharacterOffset(value, offset);
  if (cursor === 0) return { value, cursor };
  characters.splice(cursor - 1, 1);
  return { value: characters.join(""), cursor: cursor - 1 };
}

function removeCharacterAt(value: string, offset: number): string {
  const characters = Array.from(value);
  const cursor = clampCharacterOffset(value, offset);
  if (cursor < characters.length) characters.splice(cursor, 1);
  return characters.join("");
}

function bracketedPaste(data: string): string | undefined {
  const start = "\u001b[200~";
  const end = "\u001b[201~";
  return data.startsWith(start) && data.endsWith(end)
    ? data.slice(start.length, -end.length)
    : undefined;
}

function printableInput(data: string): string | undefined {
  const decoded = decodeKittyPrintable(data);
  if (decoded !== undefined) return decoded;
  return data.length > 0 && !/[\p{Control}]/u.test(data) ? data : undefined;
}
