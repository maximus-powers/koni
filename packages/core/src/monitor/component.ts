import type { Component, Focusable } from "@earendil-works/pi-tui";
import {
  decodeKittyPrintable,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { MonitorController, MonitorControllerSnapshot } from "./controller.js";
import type { MonitorQuestion, MonitorRunSummary } from "./protocol.js";
import type { ControlProposalInspection } from "../control-center/protocol.js";
import { plainMonitorPalette, type MonitorPalette } from "./presentation.js";
import { fitTerminalLine, terminalSafeLines, terminalSafeText } from "./terminal.js";

export interface CompactMonitorWidgetOptions {
  controller: MonitorController;
  palette?: MonitorPalette;
  requestRender?: () => void;
}

/** Non-focusable, always-present companion strip for an eligible Koni project. */
export class CompactMonitorWidget implements Component {
  readonly #controller: MonitorController;
  readonly #palette: MonitorPalette;
  readonly #requestRender: (() => void) | undefined;
  readonly #unsubscribe: () => void;
  #snapshot: MonitorControllerSnapshot;

  public constructor(options: CompactMonitorWidgetOptions) {
    this.#controller = options.controller;
    this.#palette = options.palette ?? plainMonitorPalette;
    this.#requestRender = options.requestRender;
    this.#snapshot = this.#controller.snapshot;
    this.#unsubscribe = this.#controller.subscribe((snapshot) => {
      this.#snapshot = snapshot;
      this.#requestRender?.();
    });
  }

  public invalidate(): void {
    this.#snapshot = this.#controller.snapshot;
  }

  public render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    if (this.#snapshot.connection === "disabled" || this.#snapshot.connection === "suspended")
      return [];
    const monitor = this.#snapshot.monitor;
    if (this.#snapshot.connection === "stopped" || this.#snapshot.connection === "error") {
      const suffix = this.#snapshot.connection === "error" ? "connection error" : "stopped";
      return [
        fitTerminalLine(
          `${this.#palette.bold(this.#palette.accent("Koni"))} ${this.#palette.muted(`· ${suffix} · /koni-run`)}`,
          safeWidth,
        ),
      ];
    }
    if (monitor === undefined || monitor.runs.length === 0) {
      const state = this.#snapshot.connection === "connecting" ? "checking" : "no runs";
      return [
        fitTerminalLine(
          `${this.#palette.bold(this.#palette.accent("Koni"))} ${this.#palette.muted(`· ${state} · /koni-run`)}`,
          safeWidth,
        ),
      ];
    }
    const activeAgents = monitor.runs.reduce((sum, run) => sum + run.agents.active, 0);
    const completedTickets = monitor.runs.reduce((sum, run) => sum + run.tickets.completed, 0);
    const totalTickets = monitor.runs.reduce((sum, run) => sum + run.tickets.total, 0);
    const newTokens = monitor.runs.reduce((sum, run) => sum + run.tokens.new, 0);
    const questions = monitor.runs.reduce((sum, run) => sum + run.questionCount, 0);
    const proposals = monitor.runs.reduce((sum, run) => sum + run.proposalCount, 0);
    const plans = monitor.runs.filter((run) => run.planApproval).length;
    const attention = [
      ...(questions === 0 ? [] : [`Q${questions}`]),
      ...(plans === 0 ? [] : [`P${plans}`]),
      ...(proposals === 0 ? [] : [`Δ${proposals}`]),
      ...(monitor.runs.some((run) => run.failure !== undefined || run.blocker !== undefined)
        ? ["!"]
        : []),
    ];
    const first = [
      this.#palette.bold(this.#palette.accent("Koni")),
      this.#palette.text(`${monitor.totalRuns} run${monitor.totalRuns === 1 ? "" : "s"}`),
      this.#palette.text(`${activeAgents} active agent${activeAgents === 1 ? "" : "s"}`),
      this.#palette.text(`${completedTickets}/${totalTickets} tickets`),
      this.#palette.text(`${formatTokenCount(newTokens)} new tks`),
      ...(attention.length === 0 ? [] : [this.#palette.warning(`! ${attention.join(" ")}`)]),
    ].join(this.#palette.muted(" · "));
    if (safeWidth < 58) return [fitTerminalLine(first, safeWidth)];
    const selected =
      monitor.runs.find((run) => run.id === this.#snapshot.selectedRunId) ?? monitor.runs[0]!;
    const second = `${this.#palette.accent("›")} ${this.#palette.text(selected.objectivePreview)}  ${this.#palette.muted(
      `${phaseLabel(selected.phase)} · ${selected.tickets.completed}/${selected.tickets.total} tickets · ${selected.agents.active}/${selected.agents.total} agents · /koni-runs`,
    )}`;
    return [fitTerminalLine(first, safeWidth), fitTerminalLine(second, safeWidth)];
  }

  public dispose(): void {
    this.#unsubscribe();
  }
}

export type RunsOverlayResult = { kind: "close" } | { kind: "open_full" };

interface QuestionMode {
  kind: "question";
  runId: string;
  questionIndex: number;
  optionIndex: number;
  focus: "options" | "notes" | "send";
  notes: string;
  scroll: number;
}

interface PlanMode {
  kind: "plan";
  runId: string;
  sectionIndex: number;
  scroll: number;
  focus: "document" | "steering" | "action";
  actionIndex: number;
  steering: string;
}

interface ProposalMode {
  kind: "proposal";
  runId: string;
  proposalIndex: number;
  scroll: number;
  focus: "document" | "message" | "choice" | "submit";
  decision: "approval" | "rejection" | undefined;
  message: string;
}

type OverlayMode = { kind: "runs" } | QuestionMode | PlanMode | ProposalMode;

export interface RunsOverlayComponentOptions {
  controller: MonitorController;
  done: (result: RunsOverlayResult) => void;
  palette?: MonitorPalette;
  viewportRows?: () => number;
  requestRender?: () => void;
}

/** Short-lived response panel. It intentionally has no autonomous-agent or lifecycle controls. */
export class RunsOverlayComponent implements Component, Focusable {
  public focused = false;
  readonly #controller: MonitorController;
  readonly #done: (result: RunsOverlayResult) => void;
  readonly #palette: MonitorPalette;
  readonly #viewportRows: () => number;
  readonly #requestRender: (() => void) | undefined;
  readonly #unsubscribe: () => void;
  #snapshot: MonitorControllerSnapshot;
  #mode: OverlayMode = { kind: "runs" };
  #busy = false;
  #error: string | undefined;
  #closed = false;

  public constructor(options: RunsOverlayComponentOptions) {
    this.#controller = options.controller;
    this.#done = options.done;
    this.#palette = options.palette ?? plainMonitorPalette;
    this.#viewportRows = options.viewportRows ?? (() => 32);
    this.#requestRender = options.requestRender;
    this.#snapshot = options.controller.snapshot;
    this.#unsubscribe = options.controller.subscribe((snapshot) => {
      this.#snapshot = snapshot;
      this.#repairMode();
      this.#requestRender?.();
    });
  }

  public get mode(): OverlayMode {
    return structuredClone(this.#mode);
  }

  public invalidate(): void {
    this.#snapshot = this.#controller.snapshot;
  }

  public handleInput(data: string): void {
    if (this.#closed || this.#busy) return;
    if (matchesKey(data, Key.escape)) {
      if (this.#mode.kind === "runs") this.#close({ kind: "close" });
      else {
        this.#mode = { kind: "runs" };
        this.#error = undefined;
        this.#requestRender?.();
      }
      return;
    }
    if (this.#mode.kind === "runs") this.#handleRunsInput(data);
    else if (this.#mode.kind === "question") this.#handleQuestionInput(data);
    else if (this.#mode.kind === "plan") this.#handlePlanInput(data);
    else this.#handleProposalInput(data);
  }

  public render(width: number): string[] {
    const safeWidth = Math.max(20, Math.floor(width));
    const height = Math.max(8, this.#viewportRows());
    const inner = safeWidth - 2;
    const body =
      this.#mode.kind === "runs"
        ? this.#renderRuns(inner)
        : this.#mode.kind === "question"
          ? this.#renderQuestion(this.#mode, inner)
          : this.#mode.kind === "plan"
            ? this.#renderPlan(this.#mode, inner)
            : this.#renderProposal(this.#mode, inner);
    const title =
      this.#mode.kind === "runs"
        ? "Koni Runs"
        : this.#mode.kind === "question"
          ? "Question"
          : this.#mode.kind === "plan"
            ? "Plan Review"
            : "Change Proposal";
    const errorLines = this.#error === undefined ? [] : [this.#palette.error(this.#error)];
    const bodyCapacity = Math.max(3, height - 4 - errorLines.length);
    const maximumScroll = Math.max(0, body.length - bodyCapacity);
    let offset = this.#mode.kind === "question" ? Math.min(this.#mode.scroll, maximumScroll) : 0;
    if (this.#mode.kind === "runs") {
      const selected =
        this.#snapshot.monitor?.runs.findIndex((run) => run.id === this.#snapshot.selectedRunId) ??
        0;
      offset = Math.min(maximumScroll, Math.max(0, selected * 2 - Math.floor(bodyCapacity / 2)));
    } else if (
      (this.#mode.kind === "plan" || this.#mode.kind === "proposal") &&
      this.#mode.focus !== "document"
    ) {
      offset = maximumScroll;
    }
    const visibleBody = body.slice(offset, offset + bodyCapacity);
    if (offset > 0 && visibleBody.length > 0) visibleBody[0] = this.#palette.dim("↑ more");
    if (offset < maximumScroll && visibleBody.length > 0)
      visibleBody[visibleBody.length - 1] = this.#palette.dim("↓ more");
    const lines = [
      `${this.#palette.border("┌")} ${this.#palette.bold(this.#palette.accent(title))}${this.#palette.border("─".repeat(Math.max(0, inner - visibleWidth(title) - 1)))}${this.#palette.border("┐")}`,
      ...visibleBody,
      ...errorLines,
      this.#palette.muted(this.#footer()),
      this.#palette.border(`└${"─".repeat(inner)}┘`),
    ];
    while (lines.length < height) lines.splice(lines.length - 2, 0, "");
    return lines.map((line, index) => {
      if (index === 0 || index === lines.length - 1) return fitTerminalLine(line, safeWidth);
      return `${this.#palette.border("│")}${fitTerminalLine(line, inner, true)}${this.#palette.border("│")}`;
    });
  }

  public dispose(): void {
    this.#closed = true;
    this.#unsubscribe();
  }

  #handleRunsInput(data: string): void {
    if (data === "o") {
      this.#close({ kind: "open_full" });
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") this.#controller.moveSelection(-1);
    else if (matchesKey(data, Key.down) || data === "j") this.#controller.moveSelection(1);
    else if (matchesKey(data, Key.enter)) this.#openSelectedAttention();
  }

  #handleQuestionInput(data: string): void {
    const mode = this.#mode as QuestionMode;
    const attention = this.#snapshot.attentions[mode.runId];
    const question = attention?.questions[mode.questionIndex];
    if (question === undefined) return;
    if (mode.focus === "notes") {
      if (matchesKey(data, Key.ctrl(Key.enter))) {
        void this.#submitQuestion(mode, question);
      } else if (matchesKey(data, Key.tab)) {
        mode.focus = "send";
        mode.scroll = Number.MAX_SAFE_INTEGER;
      } else if (matchesKey(data, Key.shift(Key.tab))) {
        mode.focus = "options";
      } else if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
        mode.notes = removeLastCodePoint(mode.notes);
      } else if (
        matchesKey(data, Key.enter) ||
        matchesKey(data, Key.shift(Key.enter)) ||
        matchesKey(data, Key.alt(Key.enter))
      ) {
        mode.notes = boundedAppend(mode.notes, "\n", 8_000);
      } else {
        const printable = printableInput(data);
        if (printable !== undefined) mode.notes = boundedAppend(mode.notes, printable, 8_000);
      }
      this.#requestRender?.();
      return;
    }
    if (matchesKey(data, Key.left) || data === "[") {
      mode.questionIndex = cycle(mode.questionIndex, -1, attention?.questions.length ?? 1);
      mode.optionIndex = preferredOptionIndex(attention!.questions[mode.questionIndex]!);
      mode.scroll = 0;
    } else if (matchesKey(data, Key.right) || data === "]") {
      mode.questionIndex = cycle(mode.questionIndex, 1, attention?.questions.length ?? 1);
      mode.optionIndex = preferredOptionIndex(attention!.questions[mode.questionIndex]!);
      mode.scroll = 0;
    } else if (matchesKey(data, Key.up) || data === "k") {
      mode.optionIndex = cycle(mode.optionIndex, -1, optionCount(question));
    } else if (matchesKey(data, Key.down) || data === "j") {
      mode.optionIndex = cycle(mode.optionIndex, 1, optionCount(question));
    } else if (matchesKey(data, Key.tab)) {
      mode.focus = question.allowsNotes ? "notes" : "send";
      if (mode.focus === "send") mode.scroll = Number.MAX_SAFE_INTEGER;
    } else if (matchesKey(data, Key.shift(Key.tab))) {
      mode.focus = "send";
      mode.scroll = Number.MAX_SAFE_INTEGER;
    } else if (matchesKey(data, Key.pageUp)) {
      mode.scroll = Math.max(0, mode.scroll - 6);
    } else if (matchesKey(data, Key.pageDown)) {
      mode.scroll = Math.min(Number.MAX_SAFE_INTEGER, mode.scroll + 6);
    } else if (matchesKey(data, Key.enter)) {
      if (mode.focus === "send") void this.#submitQuestion(mode, question);
      else mode.focus = question.allowsNotes ? "notes" : "send";
      if (mode.focus === "send") mode.scroll = Number.MAX_SAFE_INTEGER;
    }
    this.#requestRender?.();
  }

  #handlePlanInput(data: string): void {
    const mode = this.#mode as PlanMode;
    if (mode.focus === "steering") {
      if (matchesKey(data, Key.ctrl(Key.enter))) {
        void this.#submitPlanAction(mode, 0);
      } else if (matchesKey(data, Key.tab)) {
        mode.focus = "action";
        mode.actionIndex = 0;
      } else if (matchesKey(data, Key.shift(Key.tab))) {
        mode.focus = "document";
      } else if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
        mode.steering = removeLastCodePoint(mode.steering);
      } else if (
        matchesKey(data, Key.enter) ||
        matchesKey(data, Key.shift(Key.enter)) ||
        matchesKey(data, Key.alt(Key.enter))
      ) {
        mode.steering = boundedAppend(mode.steering, "\n", 16_000);
      } else {
        const printable = printableInput(data);
        if (printable !== undefined)
          mode.steering = boundedAppend(mode.steering, printable, 16_000);
      }
      this.#requestRender?.();
      return;
    }
    if (matchesKey(data, Key.tab)) mode.focus = mode.focus === "document" ? "steering" : "document";
    else if (matchesKey(data, Key.shift(Key.tab)) || matchesKey(data, Key.up))
      mode.focus = "document";
    else if (matchesKey(data, Key.left) || data === "[") {
      if (mode.focus === "action") mode.actionIndex = cycle(mode.actionIndex, -1, 2);
      else mode.sectionIndex = cycle(mode.sectionIndex, -1, 4);
    } else if (matchesKey(data, Key.right) || data === "]") {
      if (mode.focus === "action") mode.actionIndex = cycle(mode.actionIndex, 1, 2);
      else mode.sectionIndex = cycle(mode.sectionIndex, 1, 4);
    } else if (matchesKey(data, Key.pageUp)) mode.scroll = Math.max(0, mode.scroll - 6);
    else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.down)) mode.scroll += 6;
    else if (matchesKey(data, Key.enter)) {
      if (mode.focus === "document") mode.focus = "steering";
      else if (mode.focus === "action") void this.#submitPlanAction(mode, mode.actionIndex);
    }
    this.#requestRender?.();
  }

  #handleProposalInput(data: string): void {
    const mode = this.#mode as ProposalMode;
    const proposals = this.#snapshot.attentions[mode.runId]?.proposals ?? [];
    if (proposals[mode.proposalIndex] === undefined) return;
    if (mode.focus === "message") {
      if (matchesKey(data, Key.ctrl(Key.enter))) {
        mode.focus = "choice";
      } else if (matchesKey(data, Key.tab)) {
        mode.focus = "choice";
      } else if (matchesKey(data, Key.shift(Key.tab))) {
        mode.focus = "document";
      } else if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
        mode.message = removeLastCodePoint(mode.message);
      } else if (
        matchesKey(data, Key.enter) ||
        matchesKey(data, Key.shift(Key.enter)) ||
        matchesKey(data, Key.alt(Key.enter))
      ) {
        mode.message = boundedAppend(mode.message, "\n", 8_000);
      } else {
        const printable = printableInput(data);
        if (printable !== undefined) mode.message = boundedAppend(mode.message, printable, 8_000);
      }
      this.#requestRender?.();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      mode.focus =
        mode.focus === "document" ? "message" : mode.focus === "choice" ? "submit" : "document";
    } else if (matchesKey(data, Key.shift(Key.tab))) {
      mode.focus =
        mode.focus === "submit" ? "choice" : mode.focus === "choice" ? "message" : "document";
    } else if ((matchesKey(data, Key.left) || data === "[") && mode.focus === "document") {
      mode.proposalIndex = cycle(mode.proposalIndex, -1, proposals.length);
      mode.scroll = 0;
      mode.decision = undefined;
      mode.message = "";
    } else if ((matchesKey(data, Key.right) || data === "]") && mode.focus === "document") {
      mode.proposalIndex = cycle(mode.proposalIndex, 1, proposals.length);
      mode.scroll = 0;
      mode.decision = undefined;
      mode.message = "";
    } else if (
      (matchesKey(data, Key.left) || matchesKey(data, Key.up) || data === "[") &&
      mode.focus === "choice"
    ) {
      mode.decision = mode.decision === "approval" ? "rejection" : "approval";
    } else if (
      (matchesKey(data, Key.right) || matchesKey(data, Key.down) || data === "]") &&
      mode.focus === "choice"
    ) {
      mode.decision = mode.decision === "rejection" ? "approval" : "rejection";
    } else if (matchesKey(data, Key.pageUp) && mode.focus === "document") {
      mode.scroll = Math.max(0, mode.scroll - 6);
    } else if (matchesKey(data, Key.pageDown) && mode.focus === "document") {
      mode.scroll += 6;
    } else if (matchesKey(data, Key.ctrl(Key.enter))) {
      if (mode.focus === "submit") void this.#submitProposal(mode, proposals[mode.proposalIndex]!);
      else {
        mode.focus = mode.focus === "document" ? "message" : "submit";
      }
    } else if (matchesKey(data, Key.enter)) {
      if (mode.focus === "document") mode.focus = "message";
      else if (mode.focus === "choice") mode.focus = "submit";
      else if (mode.focus === "submit") {
        this.#error = "Use Ctrl+Enter to record the selected decision.";
      }
    }
    this.#requestRender?.();
  }

  #openSelectedAttention(): void {
    const runId = this.#snapshot.selectedRunId;
    if (runId === undefined) return;
    const attention = this.#snapshot.attentions[runId];
    if (attention?.questions.length) {
      this.#mode = {
        kind: "question",
        runId,
        questionIndex: 0,
        optionIndex: preferredOptionIndex(attention.questions[0]!),
        focus: "options",
        notes: "",
        scroll: 0,
      };
    } else if (attention?.plan !== undefined) {
      this.#mode = {
        kind: "plan",
        runId,
        sectionIndex: 0,
        scroll: 0,
        focus: "document",
        actionIndex: 0,
        steering: "",
      };
    } else if (attention?.proposals.length) {
      this.#mode = {
        kind: "proposal",
        runId,
        proposalIndex: 0,
        scroll: 0,
        focus: "document",
        decision: undefined,
        message: "",
      };
    } else {
      const run = this.#snapshot.monitor?.runs.find((candidate) => candidate.id === runId);
      if (run?.blocker !== undefined || run?.failure !== undefined || run?.mergeReady === true) {
        this.#close({ kind: "open_full" });
        return;
      }
    }
    this.#error = undefined;
    this.#requestRender?.();
  }

  async #submitQuestion(mode: QuestionMode, question: MonitorQuestion): Promise<void> {
    const selected =
      mode.optionIndex < question.options.length
        ? question.options[mode.optionIndex]?.id
        : undefined;
    this.#busy = true;
    this.#error = undefined;
    this.#requestRender?.();
    try {
      await this.#controller.answerQuestion({
        runId: mode.runId,
        questionId: question.id,
        ...(selected === undefined ? {} : { selectedOptionId: selected }),
        ...(mode.notes.trim().length === 0 ? {} : { notes: mode.notes }),
      });
      const remaining = this.#snapshot.attentions[mode.runId]?.questions ?? [];
      if (question.batchId === undefined || remaining.length === 0) this.#mode = { kind: "runs" };
      else {
        const next = Math.min(mode.questionIndex, remaining.length - 1);
        this.#mode = {
          kind: "question",
          runId: mode.runId,
          questionIndex: next,
          optionIndex: preferredOptionIndex(remaining[next]!),
          focus: "options",
          notes: "",
          scroll: 0,
        };
      }
    } catch (error) {
      this.#error = terminalSafeText(error instanceof Error ? error.message : String(error), {
        maxCodePoints: 256,
      });
    } finally {
      this.#busy = false;
      this.#requestRender?.();
    }
  }

  async #submitPlanAction(mode: PlanMode, action: number): Promise<void> {
    if (action === 1) {
      this.#mode = { kind: "runs" };
      this.#requestRender?.();
      return;
    }
    this.#busy = true;
    this.#error = undefined;
    this.#requestRender?.();
    try {
      if (mode.steering.trim().length === 0) await this.#controller.approvePlan(mode.runId);
      else await this.#controller.revisePlan(mode.runId, mode.steering);
      this.#mode = { kind: "runs" };
    } catch (error) {
      this.#error = terminalSafeText(error instanceof Error ? error.message : String(error), {
        maxCodePoints: 256,
      });
    } finally {
      this.#busy = false;
      this.#requestRender?.();
    }
  }

  async #submitProposal(mode: ProposalMode, proposal: ControlProposalInspection): Promise<void> {
    if (mode.decision === undefined) {
      this.#error = "Choose Approve or Reject before recording a decision.";
      this.#requestRender?.();
      return;
    }
    this.#busy = true;
    this.#error = undefined;
    this.#requestRender?.();
    try {
      await this.#controller.decideProposal({
        runId: mode.runId,
        ticketId: proposal.ticketId,
        decision: mode.decision,
        ...(mode.message.trim().length === 0 ? {} : { message: mode.message }),
      });
      this.#mode = { kind: "runs" };
    } catch (error) {
      this.#error = terminalSafeText(error instanceof Error ? error.message : String(error), {
        maxCodePoints: 256,
      });
    } finally {
      this.#busy = false;
      this.#requestRender?.();
    }
  }

  #renderRuns(width: number): string[] {
    const monitor = this.#snapshot.monitor;
    if (this.#snapshot.connection === "stopped" || this.#snapshot.connection === "error") {
      return [
        "",
        this.#palette.warning("Koni authority is stopped."),
        this.#palette.muted("Runs remain durable. Use /koni-run or /koni to reconnect."),
        "",
      ];
    }
    if (monitor === undefined || monitor.runs.length === 0) {
      return [
        "",
        this.#palette.muted("No runs yet."),
        this.#palette.dim("Start one with /koni-run."),
        "",
      ];
    }
    const lines: string[] = [];
    for (const run of monitor.runs) {
      const selected = run.id === this.#snapshot.selectedRunId;
      const attention = attentionBadge(run);
      const title = `${selected ? "›" : " "} ${phaseMark(run)} ${run.objectivePreview}`;
      lines.push(selected ? this.#palette.selected(title) : title);
      lines.push(
        this.#palette.muted(
          `    ${phaseLabel(run.phase)} · ${run.tickets.completed}/${run.tickets.total} tickets · ${run.agents.active}/${run.agents.total} agents · ${formatTokenCount(run.tokens.new)} new tks${attention}`,
        ),
      );
    }
    if (monitor.truncated)
      lines.push(
        this.#palette.dim(
          `${monitor.totalRuns - monitor.runs.length} more runs are available in /koni.`,
        ),
      );
    return lines.map((line) => truncateToWidth(line, width, "…", true));
  }

  #renderQuestion(mode: QuestionMode, width: number): string[] {
    const attention = this.#snapshot.attentions[mode.runId];
    const question = attention?.questions[mode.questionIndex];
    if (question === undefined)
      return [
        this.#palette.muted("This question was resolved."),
        "",
        this.#palette.dim("Esc returns to runs."),
      ];
    const lines = [
      this.#palette.muted(
        `Question ${mode.questionIndex + 1}/${attention!.questions.length}` +
          (question.batchSize === undefined
            ? ""
            : ` · ${question.batchPosition}/${question.batchSize} in batch`),
      ),
      ...terminalSafeLines(question.prompt, width, { maxCodePoints: 4_096, maxLines: 8 }).map(
        (line) => this.#palette.bold(line),
      ),
      "",
    ];
    question.options.forEach((option, index) => {
      const recommendation = question.recommendedOptionId === option.id ? " ★ Recommended" : "";
      lines.push(
        index === mode.optionIndex
          ? this.#palette.selected(`● ${option.label}${recommendation}`)
          : `○ ${option.label}${recommendation}`,
      );
      lines.push(
        ...terminalSafeLines(option.description, Math.max(1, width - 3), { maxLines: 4 }).map(
          (line) => this.#palette.muted(`   ${line}`),
        ),
      );
    });
    if (question.allowsNotes) {
      const noneIndex = question.options.length;
      lines.push(
        noneIndex === mode.optionIndex
          ? this.#palette.selected("● None of the above")
          : "○ None of the above",
      );
      lines.push("", sectionLabel("Notes", width, this.#palette));
      const notes = mode.notes.length === 0 ? this.#palette.dim("Optional notes…") : mode.notes;
      lines.push(...terminalSafeLines(notes, width, { maxCodePoints: 8_000, maxLines: 5 }));
    }
    const label =
      question.batchId === undefined
        ? "Send answer"
        : question.resolvesBatchOnSubmit === true
          ? (question.batchSize ?? 1) > 1
            ? "Submit all answers"
            : "Submit answer"
          : question.answerSaved === true
            ? "Revise answer"
            : "Save & next";
    lines.push(
      "",
      mode.focus === "send"
        ? this.#palette.selected(this.#busy ? " Sending… " : ` ${label} `)
        : this.#palette.accent(`[ ${label} ]`),
    );
    return lines;
  }

  #renderPlan(mode: PlanMode, width: number): string[] {
    const plan = this.#snapshot.attentions[mode.runId]?.plan;
    if (plan === undefined)
      return [
        this.#palette.muted("This plan no longer needs approval."),
        "",
        this.#palette.dim("Esc returns to runs."),
      ];
    const sectionIds = ["architecture", "decisions", "risk", "verification"] as const;
    const tabs = sectionIds
      .map((section, index) =>
        index === mode.sectionIndex
          ? this.#palette.selected(capitalize(section))
          : this.#palette.muted(capitalize(section)),
      )
      .join("  ");
    const section = sectionIds[mode.sectionIndex]!;
    const document: string[] = [];
    for (const item of plan.sections[section]) {
      document.push(this.#palette.bold(item.title));
      document.push(
        ...terminalSafeLines(item.description, width, { maxCodePoints: 2_048, maxLines: 8 }).map(
          (line) => this.#palette.muted(line),
        ),
      );
      document.push("");
    }
    if (document.length === 0)
      document.push(this.#palette.muted("No authored summary for this section."));
    const primary = mode.steering.trim().length === 0 ? "Approve" : "Revise plan";
    const actions = [primary, "Later"]
      .map((label, index) =>
        mode.focus === "action" && index === mode.actionIndex
          ? this.#palette.selected(` ${label} `)
          : this.#palette.accent(`[ ${label} ]`),
      )
      .join("  ");
    return [
      tabs,
      "",
      ...document.slice(mode.scroll, mode.scroll + 12),
      sectionLabel("Steering instructions", width, this.#palette),
      ...terminalSafeLines(
        mode.steering.length === 0 ? "Add steering to request a revised plan…" : mode.steering,
        width,
        { maxLines: 5 },
      ).map((line) => (mode.steering.length === 0 ? this.#palette.dim(line) : line)),
      "",
      actions,
    ];
  }

  #renderProposal(mode: ProposalMode, width: number): string[] {
    const proposals = this.#snapshot.attentions[mode.runId]?.proposals ?? [];
    const proposal = proposals[mode.proposalIndex];
    if (proposal === undefined) {
      return [
        this.#palette.muted("This change proposal no longer needs a decision."),
        "",
        this.#palette.dim("Esc returns to runs."),
      ];
    }
    const scope =
      proposal.targetNodeIds.length === 1
        ? "1 graph node"
        : `${proposal.targetNodeIds.length} graph nodes`;
    const decisionRows = (["approval", "rejection"] as const).map((decision) => {
      const label = decision === "approval" ? "Approve proposal" : "Reject proposal";
      const selected = mode.decision === decision;
      const row = `${selected ? "●" : "○"} ${label}`;
      return mode.focus === "choice" && selected ? this.#palette.selected(row) : row;
    });
    const submit =
      mode.decision === undefined
        ? this.#palette.dim("[ Record decision ]")
        : mode.focus === "submit"
          ? this.#palette.selected(" Record decision ")
          : this.#palette.accent("[ Record decision ]");
    return [
      this.#palette.muted(
        `Proposal ${mode.proposalIndex + 1}/${proposals.length} · ${capitalize(proposal.status)}`,
      ),
      this.#palette.bold(proposal.title),
      ...terminalSafeLines(proposal.summary, width, { maxCodePoints: 32_768, maxLines: 10 }),
      "",
      this.#palette.muted(`Scope: ${scope} · created ${proposal.createdAt}`),
      this.#palette.dim("The originating ticket and exact graph scope are compiler bound."),
      "",
      sectionLabel("Optional message", width, this.#palette),
      ...terminalSafeLines(
        mode.message.length === 0 ? "Add context for this approval or rejection…" : mode.message,
        width,
        { maxCodePoints: 8_000, maxLines: 6 },
      ).map((line) => (mode.message.length === 0 ? this.#palette.dim(line) : line)),
      "",
      ...decisionRows,
      "",
      submit,
    ];
  }

  #footer(): string {
    if (this.#busy) return "Working…";
    if (this.#mode.kind === "runs")
      return "↑/↓ select · Enter respond/open · o full Koni · Esc close";
    if (this.#mode.kind === "question")
      return "←/→ questions · ↑/↓ options · Tab focus · Ctrl+Enter send · Esc back";
    if (this.#mode.kind === "plan")
      return "←/→ sections/actions · Tab focus · Ctrl+Enter revise · Esc back";
    return "Enter never decides · Ctrl+Enter record · ←/→ proposals/choice · Tab focus · Esc back";
  }

  #repairMode(): void {
    if (this.#mode.kind === "runs") return;
    const attention = this.#snapshot.attentions[this.#mode.runId];
    if (this.#mode.kind === "question" && !attention?.questions.length)
      this.#mode = { kind: "runs" };
    if (this.#mode.kind === "plan" && attention?.plan === undefined) this.#mode = { kind: "runs" };
    if (this.#mode.kind === "proposal" && !attention?.proposals.length)
      this.#mode = { kind: "runs" };
  }

  #close(result: RunsOverlayResult): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#done(result);
  }
}

export function compactMonitorStatus(snapshot: MonitorControllerSnapshot): string | undefined {
  if (snapshot.connection === "disabled" || snapshot.connection === "suspended") return undefined;
  if (snapshot.connection === "stopped" || snapshot.connection === "error") return "Koni · stopped";
  const monitor = snapshot.monitor;
  if (monitor === undefined || monitor.runs.length === 0) return "Koni · no runs";
  const needsInput = monitor.runs.reduce(
    (sum, run) => sum + run.questionCount + run.proposalCount + (run.planApproval ? 1 : 0),
    0,
  );
  return `Koni ${monitor.totalRuns}${needsInput === 0 ? "" : ` · !${needsInput}`}`;
}

function phaseMark(run: MonitorRunSummary): string {
  if (run.failure !== undefined) return "×";
  if (run.blocker !== undefined) return "!";
  if (run.mergeReady) return "◆";
  if (["planning", "approving", "executing", "verifying", "merging"].includes(run.phase))
    return "⚙";
  if (run.phase === "paused") return "Ⅱ";
  return "●";
}

function attentionBadge(run: MonitorRunSummary): string {
  const parts = [
    ...(run.questionCount === 0 ? [] : [`Q${run.questionCount}`]),
    ...(run.planApproval ? ["plan"] : []),
    ...(run.proposalCount === 0
      ? []
      : [`${run.proposalCount} proposal${run.proposalCount === 1 ? "" : "s"}`]),
    ...(run.mergeReady ? ["merge ready"] : []),
  ];
  return parts.length === 0 ? "" : ` · ! ${parts.join(" ")}`;
}

function phaseLabel(phase: MonitorRunSummary["phase"]): string {
  return phase.split("_").map(capitalize).join(" ");
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${trimNumber(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimNumber(value / 1_000)}K`;
  return String(value);
}

function trimNumber(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/u, "");
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function optionCount(question: MonitorQuestion): number {
  return Math.max(1, question.options.length + (question.allowsNotes ? 1 : 0));
}

function preferredOptionIndex(question: MonitorQuestion): number {
  const recommended =
    question.recommendedOptionId === undefined
      ? -1
      : question.options.findIndex((option) => option.id === question.recommendedOptionId);
  return recommended < 0 ? 0 : recommended;
}

function cycle(index: number, delta: number, length: number): number {
  return length <= 0 ? 0 : (index + delta + length) % length;
}

function removeLastCodePoint(value: string): string {
  return [...value].slice(0, -1).join("");
}

function boundedAppend(value: string, suffix: string, maximum: number): string {
  return [...`${value}${suffix}`].slice(0, maximum).join("");
}

function printableInput(data: string): string | undefined {
  const decoded = decodeKittyPrintable(data);
  if (decoded !== undefined) return decoded;
  return data.length > 0 && !/[\p{Control}]/u.test(data) ? data : undefined;
}

function sectionLabel(label: string, width: number, palette: MonitorPalette): string {
  const safe = terminalSafeText(label, { maxCodePoints: 80 });
  const remaining = Math.max(0, width - visibleWidth(safe) - 2);
  const left = Math.floor(remaining / 2);
  return `${palette.border("─".repeat(left))} ${palette.muted(safe)} ${palette.border("─".repeat(remaining - left))}`;
}
