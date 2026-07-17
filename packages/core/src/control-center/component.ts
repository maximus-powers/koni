import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
  AgentRowView,
  ControlCenterViewModel,
  GraphNodeView,
} from "./view-model.js";
import { sealedModelAdmissionIssue } from "../pi/model-catalog.js";
import {
  decodeControlCenterInput,
  type ControlCenterPanel,
} from "./input.js";
import {
  ansiKoniPalette,
  type KoniPalette,
  paletteFromPiTheme,
  renderKoniMarkdown,
} from "./markdown.js";
import {
  type ControlCenterController,
  type ControlCenterControllerSnapshot,
  type ConfigureModalState,
  type ControlCenterHelpTopic,
  configResourceActions,
  type NewRunModalState,
  type PlanReviewModalState,
  selectedConfigField,
} from "./controller.js";
import type { ConfigFieldDefinition, ControlModelOption } from "./protocol.js";

export interface ControlCenterComponentOptions {
  controller: ControlCenterController;
  palette?: KoniPalette;
  viewportRows?: () => number;
  requestRender?: () => void;
}

/** One terminal component shared by Pi's custom command UI and the standalone host. */
export class ControlCenterComponent implements Component, Focusable {
  public focused = false;
  readonly #controller: ControlCenterController;
  readonly #palette: KoniPalette;
  readonly #viewportRows: () => number;
  readonly #requestRender: (() => void) | undefined;
  readonly #unsubscribe: () => void;
  readonly #ticker: NodeJS.Timeout | undefined;
  #snapshot: ControlCenterControllerSnapshot;

  public constructor(options: ControlCenterComponentOptions) {
    this.#controller = options.controller;
    this.#palette = options.palette ?? ansiKoniPalette();
    this.#viewportRows = options.viewportRows ?? (() => 40);
    this.#requestRender = options.requestRender;
    this.#snapshot = this.#controller.snapshot;
    this.#unsubscribe = this.#controller.subscribe((snapshot) => {
      this.#snapshot = snapshot;
      this.invalidate();
      this.#requestRender?.();
    });
    this.#ticker = this.#requestRender === undefined ? undefined : setInterval(() => {
      const selected = this.#snapshot.view.runs.find((run) => run.id === this.#snapshot.selection.runId);
      if (selected !== undefined && activeRun(selected.state)) this.#requestRender?.();
    }, 1_000);
    this.#ticker?.unref();
  }

  public handleInput(data: string): void {
    const action = decodeControlCenterInput(data, {
      panel: this.#snapshot.focus,
      editingNotes: this.#snapshot.questionDraft?.editingNotes ?? false,
      modalOpen: this.#snapshot.modal !== undefined,
      ...(this.#snapshot.modal === undefined ? {} : { modalKind: this.#snapshot.modal.kind }),
      editingText: modalEditingText(this.#snapshot),
      chatComposer: this.#snapshot.chat?.draft.editing ?? false,
    });
    if (action !== undefined) void this.#controller.handle(action);
  }

  public invalidate(): void {
    // Rendering is intentionally derived directly from the immutable controller snapshot.
  }

  public dispose(): void {
    this.#unsubscribe();
    if (this.#ticker !== undefined) clearInterval(this.#ticker);
  }

  public render(width: number): string[] {
    this.#snapshot = this.#controller.snapshot;
    const safeWidth = Math.max(1, width);
    const rows = Math.max(1, this.#viewportRows());
    if (safeWidth < 24 || rows < 14) {
      return fitRows([
        truncateToWidth("Koni", safeWidth, ""),
        truncateToWidth(this.#snapshot.view.projectRoot, safeWidth, ""),
      ], safeWidth, rows);
    }
    const rendered = safeWidth >= 90
      ? this.#renderWide(safeWidth, rows)
      : this.#renderCompact(safeWidth, rows);
    const withModal = this.#snapshot.modal === undefined
      ? rendered
      : overlayModal(
        rendered,
        this.#renderModal(Math.max(24, Math.min(118, safeWidth - 4)), Math.max(12, rows - 4)),
        safeWidth,
      );
    return fitRows(withModal, safeWidth, rows);
  }

  #renderWide(width: number, rows: number): string[] {
    const header = this.#header(width);
    const footer = this.#footer(width);
    const bodyHeight = Math.max(9, rows - header.length - footer.length);
    const widths = equalColumns(width, 3);
    const columns = [
      this.#leftColumn(widths[0]!, bodyHeight),
      this.#middleColumn(widths[1]!, bodyHeight),
      this.#rightColumn(widths[2]!, bodyHeight),
    ];
    return [...header, ...joinColumns(columns, widths, bodyHeight), ...footer];
  }

  #renderCompact(width: number, rows: number): string[] {
    const header = this.#header(width);
    const footer = this.#footer(width);
    const height = Math.max(8, rows - header.length - footer.length);
    const panel = this.#singlePanel(this.#snapshot.focus, width, height);
    return [...header, ...panel, ...footer];
  }

  #header(width: number): string[] {
    const run = this.#snapshot.view.selectedRun;
    const metadata = run === undefined
      ? this.#palette.muted("No runs yet")
      : [
        this.#palette.accent(run.header.runType),
        run.header.stage,
        `${run.header.ticketCount} tickets`,
        run.header.newTokens,
        ...(run.header.awaitingApproval ? [this.#palette.warning("approval needed")] : []),
      ].join(this.#palette.muted(" · "));
    const title = `${this.#palette.bold(this.#palette.accent("Koni"))} ${this.#palette.muted("·")} ${this.#palette.text(this.#snapshot.view.projectRoot)}`;
    return framedHeader(title, metadata, width, this.#palette);
  }

  #footer(width: number): string[] {
    const message = this.#snapshot.busy === undefined
      ? this.#snapshot.notice?.message
      : `⚙ ${this.#snapshot.busy}`;
    const status = message === undefined
      ? footerHelp(width)
      : message;
    const styled = this.#snapshot.notice?.kind === "error"
      ? this.#palette.error(status)
      : this.#snapshot.busy === undefined ? this.#palette.muted(status) : this.#palette.accent(status);
    return [padLine(styled, width)];
  }

  #leftColumn(width: number, height: number): string[] {
    const runsHeight = Math.max(5, Math.floor(height * 0.46));
    return [
      ...this.#runsPanel(width, runsHeight),
      ...this.#ticketsPanel(width, height - runsHeight),
    ];
  }

  #middleColumn(width: number, height: number): string[] {
    const questions = this.#snapshot.view.selectedRun?.questions;
    if (questions === undefined || questions.length === 0) return this.#detailsPanel(width, height);
    const questionHeight = Math.max(8, Math.floor(height / 3));
    return [
      ...this.#detailsPanel(width, height - questionHeight),
      ...this.#questionsPanel(width, questionHeight),
    ];
  }

  #rightColumn(width: number, height: number): string[] {
    const agentsHeight = Math.max(6, Math.floor(height * 0.31));
    const activityHeight = Math.max(6, Math.floor(height * 0.31));
    return [
      ...this.#agentsPanel(width, agentsHeight),
      ...this.#activityPanel(width, activityHeight),
      ...this.#graphPanel(width, height - agentsHeight - activityHeight),
    ];
  }

  #singlePanel(panel: ControlCenterPanel, width: number, height: number): string[] {
    switch (panel) {
      case "runs": return this.#runsPanel(width, height);
      case "tickets": return this.#ticketsPanel(width, height);
      case "details": return this.#detailsPanel(width, height);
      case "questions": return this.#questionsPanel(width, height);
      case "agents": return this.#agentsPanel(width, height);
      case "activity": return this.#activityPanel(width, height);
      case "graph": return this.#graphPanel(width, height);
    }
  }

  #runsPanel(width: number, height: number): string[] {
    const lines: string[] = [];
    let selectedLine = 0;
    for (const row of this.#snapshot.view.runs) {
      const selected = row.id === this.#snapshot.selection.runId;
      if (selected) selectedLine = lines.length;
      const marker = row.provisional ? "⚙" : row.paused ? "Ⅱ" : activeRun(row.state) ? "⚙" : row.mergeReady ? "◆" : "●";
      const primary = `${selected ? "›" : " "} ${statusStyle(marker, row.state, this.#palette)} ${row.title}`;
      const badges = [
        row.runType,
        row.stage,
        row.ticketProgress,
        row.targetBranch,
        row.newTokens,
        ...(row.mergeReady ? [this.#palette.success("ready · m")] : []),
        ...(row.awaitingApproval ? [this.#palette.warning("approve") ] : []),
      ];
      lines.push(selected ? this.#palette.selected(primary) : primary);
      lines.push(`    ${badges.join(this.#palette.muted(" · "))}`);
    }
    if (lines.length === 0) {
      lines.push(this.#palette.muted("No runs"), this.#palette.dim("Start a run from Koni's New Run flow."));
    }
    return panel(
      "Runs",
      lines,
      width,
      height,
      this.#snapshot.focus === "runs",
      this.#palette,
      visibleOffset(this.#snapshot.scroll.runs, selectedLine, height - 2),
    );
  }

  #ticketsPanel(width: number, height: number): string[] {
    const tickets = this.#snapshot.view.selectedRun?.tickets ?? [];
    const lines: string[] = [];
    let selectedLine = 0;
    for (const ticket of tickets) {
      const selected = ticket.id === this.#snapshot.selection.ticketId;
      if (selected) selectedLine = lines.length;
      const marker = ticket.active ? "⚙" : ticket.status === "Completed" ? "●" : "○";
      const line = `${selected ? "›" : " "} ${statusStyle(marker, ticket.status, this.#palette)} ${ticket.title}`;
      lines.push(selected ? this.#palette.selected(line) : line);
      lines.push(`    ${this.#palette.muted(`${ticket.status} · ${ticket.progress} steps`)}`);
    }
    if (lines.length === 0) lines.push(this.#palette.muted("Tickets appear after plan approval."));
    return panel(
      "Tickets",
      lines,
      width,
      height,
      this.#snapshot.focus === "tickets",
      this.#palette,
      visibleOffset(this.#snapshot.scroll.tickets, selectedLine, height - 2),
    );
  }

  #detailsPanel(width: number, height: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const title = detailsTitle(this.#snapshot, this.#palette);
    const run = this.#snapshot.view.selectedRun;
    const lines = run === undefined
      ? [this.#palette.muted("Select or start a run to inspect its work.")]
      : this.#detailsLines(run, innerWidth);
    return panel(
      title,
      lines,
      width,
      height,
      this.#snapshot.focus === "details",
      this.#palette,
      this.#snapshot.scroll.details,
    );
  }

  #detailsLines(run: NonNullable<ControlCenterViewModel["selectedRun"]>, width: number): string[] {
    switch (this.#snapshot.selection.detailsTab) {
      case "overview": {
        const objectiveFocused = this.#snapshot.focus === "details";
        const renderedObjective = wrapTextWithAnsi(run.objective.text, width);
        const objective = run.objective.expanded || objectiveFocused ? renderedObjective : renderedObjective.slice(0, 4);
        const lines = [
          sectionHeading("Objective", this.#palette),
          ...objective.map((line) => this.#palette.text(line)),
          this.#palette.dim(objectiveFocused ? "Focused Objective · scroll for full text" : run.objective.expanded ? "[Enter/o] collapse" : "[Enter/o] show full objective"),
        ];
        if (run.ticketDetails !== undefined) {
          lines.push(
            "",
            sectionHeading(run.ticketDetails.title, this.#palette),
            statusText(run.ticketDetails.status, this.#palette),
            ...wrapStyled(run.ticketDetails.summary, width, this.#palette.text),
          );
          if (run.ticketDetails.blocker !== undefined) {
            lines.push(...wrapStyled(run.ticketDetails.blocker, width, this.#palette.error));
          }
          lines.push("", sectionHeading("Steps", this.#palette));
          for (const step of run.ticketDetails.steps) {
            const complete = step.status === "Completed";
            const marker = complete ? this.#palette.success("●")
              : step.status === "Running" ? this.#palette.accent("⚙")
                : step.status === "Failed" ? this.#palette.error("●")
                  : this.#palette.muted("○");
            const state = complete ? "" : ` · ${step.status}`;
            lines.push(`${marker} ${step.title} · ${this.#palette.muted(step.persona)}${state}`);
            if (complete) {
              lines.push(`  ${step.summary === undefined ? this.#palette.muted("No outcome summary recorded") : this.#palette.success(step.summary)}`);
            }
          }
        }
        for (const section of run.overviewSections) {
          lines.push("", sectionHeading(section.title, this.#palette));
          for (const [index, value] of section.lines.entries()) {
            const style = section.tone === "error" ? this.#palette.error
              : section.tone === "success" ? this.#palette.success
                : this.#palette.text;
            lines.push(...wrapStyled(value, width, index === 0 && section.tone !== undefined
              ? (line) => this.#palette.bold(style(line))
              : style));
          }
        }
        return lines;
      }
      case "plan": {
        const lines: string[] = [];
        if (run.plan.mode === "activity") lines.push(this.#palette.accent("⚙ Planning is active"), "");
        for (const section of run.plan.sections) {
          lines.push(sectionHeading(section.title, this.#palette));
          lines.push(...renderKoniMarkdown(section.markdown, width, this.#palette), "");
        }
        return lines;
      }
      case "stages":
        return run.stages.flatMap((stage, index) => {
          const marker = stage.state === "done" ? this.#palette.success("●")
            : stage.state === "active" ? this.#palette.accent("⚙")
              : this.#palette.muted("○");
          return [
            ...wrapStyled(`${marker} ${index + 1}. ${stage.title}`, width, (value) => value),
            ...(stage.state === "active" ? [this.#palette.muted("   Active now")] : []),
          ];
        });
      case "chat": {
        const agent = run.agents.find((candidate) => candidate.id === this.#snapshot.selection.attemptId);
        if (agent === undefined) return [this.#palette.muted("Select an agent to inspect its session.")];
        const lines = [
          sectionHeading(agent.label, this.#palette),
          `${agent.active ? this.#palette.accent("⚙ active") : this.#palette.muted(agent.status)} · ${modelStyle(agent.model, this.#palette)} · ${thinkingStyle(agent.thinking, this.#palette)}`,
          "",
          this.#palette.muted(agent.work),
          ...(agent.active ? [] : [this.#palette.muted("Historical session · read-only")]),
        ];
        const chat = this.#snapshot.chat;
        if (chat === undefined || chat.status === "loading") lines.push("", this.#palette.accent("⚙ Loading Pi session…"));
        else if (chat.status === "unavailable") lines.push("", this.#palette.muted("This authority does not expose persisted Pi transcripts."));
        else if (chat.status === "error") lines.push("", this.#palette.error(chat.error ?? "Pi transcript could not be loaded."));
        else {
          for (const block of chat.blocks) {
            lines.push("", transcriptHeading(block.kind, `${block.branch ? "↳ " : ""}${block.title}`, this.#palette));
            lines.push(...renderKoniMarkdown(block.markdown, width, this.#palette));
          }
          for (const diagnostic of chat.diagnostics) lines.push("", this.#palette.warning(diagnostic));
        }
        if (chat !== undefined && agent.active) {
          lines.push(
            "",
            sectionHeading("Message", this.#palette),
            `${selectorBadge(chat.draft.mode === "steer" ? "Steer now" : "Follow up", chat.draft.editing, this.#palette)} ${this.#palette.muted("[Tab] mode")}`,
          );
          const value = chat.draft.text.length === 0 ? this.#palette.dim("Write steering or a follow-up…") : chat.draft.text;
          lines.push(...wrapStyled(`${chat.draft.editing ? "▌ " : "  "}${value}`, width, (line) => line));
          lines.push(this.#palette.dim(chat.draft.editing ? "[Ctrl-Enter] send · [Alt/Shift-Enter] newline · [Esc] finish" : "[Enter/s] compose"));
        }
        return lines;
      }
    }
  }

  #questionsPanel(width: number, height: number): string[] {
    const questions = this.#snapshot.view.selectedRun?.questions ?? [];
    const question = questions[this.#snapshot.questionIndex];
    if (question === undefined) {
      return panel("Questions", [this.#palette.muted("No questions pending.")], width, height, this.#snapshot.focus === "questions", this.#palette);
    }
    const inner = Math.max(1, width - 2);
    const draft = this.#snapshot.questionDraft;
    const lines = [
      this.#palette.muted(`${question.index}/${question.total}`),
      ...wrapStyled(question.prompt, inner, this.#palette.bold),
      "",
    ];
    let selectedLine = 0;
    for (const option of question.options) {
      const selected = draft?.selectedOptionId === option.id;
      if (selected) selectedLine = lines.length;
      const row = `${selected ? "●" : "○"} ${option.label}`;
      lines.push(selected ? this.#palette.selected(row) : row);
      lines.push(...wrapStyled(option.description, Math.max(1, inner - 3), (value) => `   ${this.#palette.muted(value)}`));
    }
    const noneSelected = draft?.selectedOptionId === undefined;
    if (noneSelected) selectedLine = lines.length;
    lines.push(noneSelected ? this.#palette.selected("● None of these") : "○ None of these");
    lines.push("", sectionHeading("Notes", this.#palette));
    const notes = draft?.notes ?? "";
    const noteText = notes.length === 0 ? this.#palette.dim("Add context to any answer…") : notes;
    lines.push(...wrapStyled(`${draft?.editingNotes === true ? "▌ " : "  "}${noteText}`, inner, (value) => value));
    if (draft?.editingNotes === true) selectedLine = Math.max(0, lines.length - 1);
    lines.push("", this.#palette.dim("[↑/↓] option · [←/→] question · [n/Tab] notes · [Enter] send"));
    return panel("Questions", lines, width, height, this.#snapshot.focus === "questions", this.#palette, visibleOffset(this.#snapshot.scroll.questions, selectedLine, height - 2));
  }

  #agentsPanel(width: number, height: number): string[] {
    const agents = this.#snapshot.view.selectedRun?.agents ?? [];
    const lines: string[] = [];
    let selectedLine = 0;
    for (const agent of agents) {
      const selected = agent.id === this.#snapshot.selection.attemptId;
      if (selected) selectedLine = lines.length;
      const marker = agent.active ? this.#palette.accent("⚙") : this.#palette.muted("●");
      const row = `${selected ? "›" : " "} ${marker} ${agent.label} · ${this.#palette.muted(agent.work)}`;
      lines.push(selected ? this.#palette.selected(row) : agent.active ? row : this.#palette.muted(row));
      lines.push(`    ${modelStyle(agent.model, this.#palette)} · ${thinkingStyle(agent.thinking, this.#palette)} · ${agent.newTokens} new`);
    }
    if (lines.length === 0) lines.push(this.#palette.muted("No agent attempts yet."));
    return panel("Agents", lines, width, height, this.#snapshot.focus === "agents", this.#palette, visibleOffset(this.#snapshot.scroll.agents, selectedLine, height - 2));
  }

  #activityPanel(width: number, height: number): string[] {
    const run = this.#snapshot.view.selectedRun;
    const title = recentActivityTitle(run?.activeDuration, Math.max(1, width - 2));
    const lines = run?.activity.flatMap((activity) => wrapStyled(
      `${this.#palette.muted(activity.timestamp)}  ${activityStyle(activity.kind, activity.message, this.#palette)}`,
      Math.max(1, width - 2),
      (value) => value,
    )) ?? [];
    if (lines.length === 0) lines.push(this.#palette.muted("No activity recorded."));
    return panel(title, lines, width, height, this.#snapshot.focus === "activity", this.#palette, this.#snapshot.scroll.activity);
  }

  #graphPanel(width: number, height: number): string[] {
    const graph = this.#snapshot.view.selectedRun?.graph;
    const lines = graph === undefined || graph.nodes.length === 0
      ? [this.#palette.muted("No graph nodes yet.")]
      : renderGraphLines(graph.nodes, graph.edges, Math.max(1, width - 2), this.#palette);
    return panel(
      graph === undefined ? "Graph" : `Graph · ${graph.scope}`,
      lines,
      width,
      height,
      this.#snapshot.focus === "graph",
      this.#palette,
      this.#snapshot.scroll.graph,
    );
  }

  #renderModal(width: number, height: number): string[] {
    const modal = this.#snapshot.modal!;
    if (modal.kind === "delete") {
      return panel(
        "Delete run?",
        [
          ...wrapStyled(modal.title, width - 2, this.#palette.bold),
          "",
          this.#palette.error("This stops every associated Pi session before cleanup."),
          this.#palette.muted("Durable deletion prevents the run from spending more tokens."),
          "",
          `${this.#palette.error("[Enter] Delete")}   ${this.#palette.muted("[Esc] Cancel")}`,
        ],
        width,
        Math.min(height, 9),
        true,
        this.#palette,
      );
    }
    if (modal.kind === "new_run") return this.#renderNewRun(modal, width, height);
    if (modal.kind === "plan_review") return this.#renderPlanReview(modal, width, height);
    if (modal.kind === "configure") return this.#renderConfigure(modal, width, height);
    const help = HELP[modal.topic];
    return panel(
      `Help · ${help.title}`,
      [
        ...wrapStyled(help.description, width - 2, this.#palette.text),
        "",
        sectionHeading("Actions", this.#palette),
        ...help.actions.map(([keys, meaning]) => `${this.#palette.accent(keys.padEnd(16))}${meaning}`),
        "",
        this.#palette.muted("[h/F1/Esc/Enter] close"),
      ],
      width,
      Math.min(height, Math.min(18, 8 + help.actions.length)),
      true,
      this.#palette,
    );
  }

  #renderNewRun(modal: NewRunModalState, width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const runType = this.#snapshot.runTypes.find((item) => item.id === modal.runTypeId);
    const objectiveLines = wrapTextWithAnsi(modal.objective.length === 0 ? "Describe the outcome…" : modal.objective, inner - 2);
    const objectiveVisible = objectiveLines.slice(Math.max(0, objectiveLines.length - (height >= 30 ? 3 : 1)));
    const runTypeBadges = this.#snapshot.runTypes.map((item) => runTypeBadge(item.title, item.id === modal.runTypeId, this.#palette));
    const runTypeLines = wrapSegments(runTypeBadges, inner);
    const fixedRows = 15 + objectiveVisible.length + modal.roles.length + runTypeLines.length;
    const stageBudget = Math.max(1, height - fixedRows);
    const stages = runType?.stages ?? [];
    const stageStart = Math.min(modal.stageScroll, Math.max(0, stages.length - 1));
    const stageLines: string[] = [];
    let stageCount = 0;
    for (let index = stageStart; index < stages.length; index += 1) {
      const stage = stages[index]!;
      const marker = stage.included ? this.#palette.accent("●") : this.#palette.dim("○");
      const rows = [
        ...(stageLines.length > 0 ? [this.#palette.dim("  ↓")] : []),
        ...wrapStyled(`${marker} ${stage.title}`, inner, stage.included ? this.#palette.text : this.#palette.dim),
      ];
      if (stageLines.length > 0 && stageLines.length + rows.length > stageBudget) break;
      stageLines.push(...rows);
      stageCount += 1;
    }
    if (height <= 20) {
      const stage = stages[stageStart];
      const compact: string[] = [
        centeredDivider("Goal Prompt", inner, this.#palette),
        modal.focus === "objective"
          ? this.#palette.selected(` ${objectiveVisible.at(-1) ?? "Describe the outcome…"}`)
          : ` ${objectiveVisible.at(-1) ?? this.#palette.dim("Describe the outcome…")}`,
        centeredDivider("Run Config", inner, this.#palette),
        selectorWindow(this.#snapshot.runTypes.map((item) => item.title), Math.max(0, this.#snapshot.runTypes.findIndex((item) => item.id === modal.runTypeId)), inner, this.#palette),
        selectorLine("Target branch", modal.branches[modal.branchIndex]?.label ?? "No branch", modal.focus === "branch", this.#palette),
        `${modal.focus === "stages" ? this.#palette.accent("›") : " "} ${this.#palette.bold(`Stages ${stageStart + 1}/${stages.length}`)} · ${stage?.included === false ? this.#palette.dim(stage.title) : this.#palette.text(stage?.title ?? "No stages")}`,
        `${this.#palette.muted("Questions")} ${["none", "some", "many"].map((value) => questionBadge(value, modal.questionPolicy === value, this.#palette)).join(" ")}  ${this.#palette.muted("Parallel")} ${inputBadge(String(modal.maxParallel), modal.focus === "parallel", this.#palette)}`,
        `${" ".repeat(13)}${this.#palette.muted("Model")}           ${this.#palette.muted("Reasoning")}`,
      ];
      for (const role of modal.roles) {
        const model = this.#snapshot.models.find((item) => item.provider === role.provider && item.id === role.model);
        const modelLabel = `${model?.name ?? role.model}${model?.available === false ? " !" : ""}`;
        compact.push(`${role.title.padEnd(12)} ${inputBadge(modelLabel, modal.focus === `role:${role.id}:model`, this.#palette)} ${inputBadge(role.thinkingLevel, modal.focus === `role:${role.id}:thinking`, this.#palette, thinkingStyle)}`);
      }
      const warning = selectedModelWarning(modal, this.#snapshot.models);
      if (warning !== undefined) compact.push(this.#palette.warning(truncateToWidth(warning, inner, "…", true)));
      const label = runType?.startMode === "work" ? "Start Work" : "Start Planning";
      compact.push(centeredButton(label, modal.focus === "start", this.#palette));
      compact.push(this.#palette.dim("Tab/↑↓ move · ←→ change · PgUp/PgDn stages · Enter select · Esc close · h help"));
      return panel("New run", compact, width, height, true, this.#palette);
    }
    const lines = [
      centeredDivider("Goal Prompt", inner, this.#palette),
      ...objectiveVisible.map((line) => modal.focus === "objective" ? this.#palette.selected(` ${line}`) : ` ${line}`),
      centeredDivider("Run Config", inner, this.#palette),
      ...runTypeLines,
      selectorLine("Target branch", modal.branches[modal.branchIndex]?.label ?? "No branch", modal.focus === "branch", this.#palette),
      `${modal.focus === "stages" ? this.#palette.accent("›") : " "} ${this.#palette.bold("Stages")} ${this.#palette.muted(`${stageStart + 1}–${Math.min(stages.length, stageStart + stageCount)} of ${stages.length}`)}`,
      ...stageLines,
      `${this.#palette.muted("Questions")} ${["none", "some", "many"].map((value) => questionBadge(value, modal.questionPolicy === value, this.#palette)).join(" ")}`,
      selectorLine("Max parallel agents", String(modal.maxParallel), modal.focus === "parallel", this.#palette),
      `${" ".repeat(Math.min(24, Math.max(0, inner - 30)))}${this.#palette.muted("Model")}           ${this.#palette.muted("Reasoning")}`,
    ];
    for (const role of modal.roles) {
      const modelFocus = modal.focus === `role:${role.id}:model`;
      const thinkingFocus = modal.focus === `role:${role.id}:thinking`;
      const model = this.#snapshot.models.find((item) => item.provider === role.provider && item.id === role.model);
      const modelLabel = `${model?.name ?? role.model}${model?.available === false ? " !" : ""}`;
      lines.push(`${role.title.padEnd(12)} ${inputBadge(modelLabel, modelFocus, this.#palette)} ${inputBadge(role.thinkingLevel, thinkingFocus, this.#palette, thinkingStyle)}`);
    }
    const warning = selectedModelWarning(modal, this.#snapshot.models);
    if (warning !== undefined) lines.push(...wrapStyled(warning, inner, this.#palette.warning));
    const label = runType?.startMode === "work" ? "Start Work" : "Start Planning";
    lines.push("", centeredButton(label, modal.focus === "start", this.#palette));
    lines.push(this.#palette.dim("Tab/↑↓ moves · ←→ changes · PgUp/PgDn stages · Enter newline/select · Esc close · h help"));
    return panel("New run", lines, width, height, true, this.#palette);
  }

  #renderPlanReview(modal: PlanReviewModalState, width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const approval = this.#snapshot.view.selectedRun?.approval;
    const sections = approval?.sections ?? [
      { id: "architecture", title: "Architecture", items: [] },
      { id: "decisions", title: "Decisions", items: [] },
      { id: "risk", title: "Risk", items: [] },
      { id: "verification", title: "Verification", items: [] },
    ];
    const current = sections[Math.min(modal.sectionIndex, sections.length - 1)]!;
    const tabs = sections.map((section, index) => selectorBadge(section.title, index === modal.sectionIndex, this.#palette)).join(this.#palette.muted("  "));
    const document: string[] = [];
    if (current.items.length === 0) {
      document.push(this.#palette.muted("No agent-authored concise review items were recorded for this section."));
    } else {
      current.items.forEach((item, index) => {
        if (index > 0) document.push("");
        document.push(this.#palette.bold(item.title));
        document.push(...wrapStyled(item.description, inner, this.#palette.text));
      });
    }
    if (current.id === "verification" && (approval?.graphSeed.length ?? 0) > 0) {
      document.push("", sectionHeading("Graph Seed", this.#palette));
      document.push(...approval!.graphSeed.flatMap((line) => wrapStyled(line, inner, this.#palette.muted)));
    }
    const steeringLines = wrapTextWithAnsi(modal.steering.length === 0 ? "Add steering here to request a revised plan…" : modal.steering, inner - 2);
    const editorRows = Math.max(2, Math.min(4, Math.floor(height / 5)));
    const bodyRows = Math.max(2, height - editorRows - 8);
    const bodyStart = Math.min(modal.scroll, Math.max(0, document.length - bodyRows));
    const visibleDocument = document.slice(bodyStart, bodyStart + bodyRows);
    while (visibleDocument.length < bodyRows) visibleDocument.push("");
    const steeringVisible = steeringLines.slice(Math.max(0, steeringLines.length - editorRows));
    while (steeringVisible.length < editorRows) steeringVisible.push("");
    const hasSteering = modal.steering.trim().length > 0;
    const button = hasSteering ? "Revise plan" : "Approve run";
    const lines = [
      tabs,
      ...visibleDocument,
      centeredDivider("Steering instructions", inner, this.#palette),
      ...steeringVisible.map((line, index) => `${modal.focus === "steering" && index === steeringVisible.length - 1 ? "▌" : " "} ${modal.steering.length === 0 ? this.#palette.dim(line) : line}`),
      centeredButton(button, modal.focus === "action", this.#palette),
      this.#palette.dim("←→/[] sections · ↑↓/jk/PgUp/PgDn scroll · Tab focus · Enter · Esc"),
    ];
    return panel("Review plan", lines, width, height, true, this.#palette);
  }

  #renderConfigure(modal: ConfigureModalState, width: number, height: number): string[] {
    if (modal.resourceOperation !== undefined) {
      return this.#renderConfigResourceOperation(modal, width, height);
    }
    const inner = Math.max(1, width - 2);
    const section = modal.catalog.sections[modal.sectionIndex];
    const resource = section?.resources[modal.resourceIndex];
    const sections = selectorWindow(
      modal.catalog.sections.map((item) => item.title),
      modal.sectionIndex,
      inner,
      this.#palette,
    );
    const contentHeight = Math.max(5, height - 8 - Number(modal.rebaseRequired));
    const leftWidth = Math.max(18, Math.min(32, Math.floor(inner * 0.31)));
    const rightWidth = Math.max(1, inner - leftWidth - 1);
    const tree = (section?.resources ?? []).map((item, index) => {
      const selected = index === modal.resourceIndex;
      const indent = "  ".repeat(Math.max(0, item.depth ?? 0));
      const row = `${indent}${index === (section?.resources.length ?? 0) - 1 ? "└" : "├"} ${item.title}`;
      return selected ? this.#palette.selected(row) : this.#palette.muted(row);
    });
    const right: string[] = [];
    if (resource === undefined) right.push(this.#palette.muted("No configurable resources in this section."));
    else {
      right.push(sectionHeading(resource.title, this.#palette));
      right.push(...wrapStyled(resource.description, rightWidth, this.#palette.muted), "");
      resource.fields.forEach((field, index) => {
        const selected = index === modal.fieldIndex;
        const value = configValueLabel(field, modal.draft[field.key], this.#snapshot.models);
        const textField = isConfigTextField(field);
        const line = textField && selected
          ? `${selected ? "›" : " "} ${field.label}`
          : `${selected ? "›" : " "} ${field.label}  ${inputBadge(value, selected && modal.focus === "field", this.#palette)}`;
        right.push(selected ? this.#palette.text(line) : this.#palette.muted(line));
        if (selected) {
          right.push(...wrapStyled(field.description, rightWidth - 2, (text) => `  ${this.#palette.dim(text)}`));
          const rawModel = modal.draft[field.key];
          if (field.kind === "model" && typeof rawModel === "string") {
            const configured = configuredModelOption(rawModel, this.#snapshot.models);
            if (configured?.available === false) {
              right.push(...wrapStyled(
                `  Unavailable: ${configured.unavailableReason ?? "The contained Pi runtime cannot execute this model."}`,
                rightWidth - 2,
                this.#palette.warning,
              ));
            }
          }
          if (field.kind === "thinking" && typeof rawModel === "string") {
            const modelField = resource.fields.find((candidate) => candidate.kind === "model");
            const configuredModel = modelField === undefined
              ? undefined
              : typeof modal.draft[modelField.key] === "string"
                ? configuredModelOption(modal.draft[modelField.key] as string, this.#snapshot.models)
                : undefined;
            if (
              configuredModel !== undefined &&
              !configuredModel.thinkingLevels.some((level) => level === rawModel)
            ) {
              right.push(...wrapStyled(
                `  Unsupported for ${configuredModel.name}. Choose: ${configuredModel.thinkingLevels.join(", ")}.`,
                rightWidth - 2,
                this.#palette.warning,
              ));
            }
          }
          if (textField) {
            const stored = modal.draft[field.key];
            const raw = modal.textEditor?.key === field.key
              ? modal.textEditor.value
              : typeof stored === "string" ? stored
                : field.kind === "string_list" && Array.isArray(stored)
                  ? stored.filter((item): item is string => typeof item === "string").join("\n")
                  : "";
            const shown = raw.length === 0 ? this.#palette.dim("Empty") : raw;
            right.push(...wrapStyled(
              `${modal.focus === "field" && modal.editing ? "▌ " : "  "}${shown}`,
              Math.max(1, rightWidth - 2),
              (text) => modal.focus === "field" ? this.#palette.selected(text) : this.#palette.text(text),
            ));
          }
        }
      });
    }
    const leftStart = Math.max(0, Math.min(modal.resourceIndex - Math.floor(contentHeight / 2), Math.max(0, tree.length - contentHeight)));
    const rightSelectedLine = Math.max(0, right.findIndex((line) => line.includes("›")));
    const rightStart = Math.max(0, Math.min(rightSelectedLine - Math.floor(contentHeight / 2), Math.max(0, right.length - contentHeight)));
    const joined = joinColumns([
      tree.slice(leftStart, leftStart + contentHeight),
      right.slice(rightStart, rightStart + contentHeight),
    ], [leftWidth, rightWidth], contentHeight);
    const actions = configResourceActions(modal);
    const actionLabels: Record<(typeof actions)[number], string> = {
      create: "[a] Add",
      duplicate: "[d] Duplicate",
      delete: "[x] Delete",
    };
    const actionRow = actions.length === 0
      ? this.#palette.dim("No collection actions for this resource")
      : actions.map((action, index) => selectorBadge(
        actionLabels[action],
        modal.focus === "actions" && modal.actionIndex === index,
        this.#palette,
      )).join(" ");
    const publish = modal.dirty ? "Publish changes" : "Configuration current";
    return panel("Configure", [
      sections,
      this.#palette.muted(section?.description ?? ""),
      ...(modal.rebaseRequired ? [this.#palette.warning("Saved draft is stale · Ctrl-R rebase or Ctrl-D discard")] : []),
      ...joined,
      actionRow,
      centeredButton(publish, modal.focus === "publish", this.#palette),
      this.#palette.dim("←→ sections/values/actions · ↑↓ resources/fields · Tab focus · Enter select · a add · d duplicate · x delete · Ctrl-S save · Ctrl-R rebase · Ctrl-P publish · Ctrl-D discard · Esc close · h help"),
    ], width, height, true, this.#palette);
  }

  #renderConfigResourceOperation(modal: ConfigureModalState, width: number, height: number): string[] {
    const operation = modal.resourceOperation!;
    const inner = Math.max(1, width - 2);
    const option = operation.options[operation.templateIndex];
    const title = operation.kind === "create" ? "Add resource"
      : operation.kind === "duplicate" ? "Duplicate resource" : "Delete resource";
    const lines: string[] = [];
    if (operation.kind === "create") {
      lines.push(sectionHeading("Resource type", this.#palette));
      lines.push(selectorWindow(
        operation.options.map((candidate) => candidate.title),
        operation.templateIndex,
        inner,
        this.#palette,
      ));
      if (option !== undefined) {
        lines.push(...boundedWrapped(option.description, inner, Math.max(1, height - 11), this.#palette.muted));
      }
    } else {
      lines.push(sectionHeading(operation.resourceTitle ?? "Selected resource", this.#palette));
    }
    if (operation.kind === "delete") {
      lines.push(
        "",
        ...boundedWrapped(
          "This removes the selected configured resource after authority validates that references and the complete project configuration remain valid.",
          inner,
          Math.max(1, height - 8),
          this.#palette.warning,
        ),
      );
    } else {
      const label = operation.kind === "create" ? option?.nameLabel ?? "Name" : "Copy name";
      lines.push(
        "",
        sectionHeading(label, this.#palette),
        operation.focus === "name"
          ? this.#palette.selected(`▌ ${operation.name.length === 0 ? "Enter a name" : operation.name}`)
          : inputBadge(operation.name.length === 0 ? "Enter a name" : operation.name, false, this.#palette),
      );
    }
    const button = operation.kind === "create" ? "Create resource"
      : operation.kind === "duplicate" ? "Duplicate resource" : "Delete resource";
    lines.push(
      "",
      centeredButton(button, operation.focus === "confirm", this.#palette),
      this.#palette.dim(operation.kind === "create" && operation.options.length > 1
        ? "←→ type · Tab/↑↓ focus · Enter select/confirm · Esc cancel · h help"
        : "Tab/↑↓ focus · Enter select/confirm · Esc cancel · h help"),
    );
    return panel(title, lines, width, Math.min(height, Math.max(10, lines.length + 2)), true, this.#palette);
  }
}

export function createPiControlCenterComponent(options: {
  tui: TUI;
  theme: Theme;
  controller: ControlCenterController;
}): ControlCenterComponent {
  return new ControlCenterComponent({
    controller: options.controller,
    palette: paletteFromPiTheme(options.theme),
    viewportRows: () => options.tui.terminal.rows,
    requestRender: () => options.tui.requestRender(),
  });
}

function panel(
  title: string,
  content: readonly string[],
  width: number,
  height: number,
  focused: boolean,
  palette: KoniPalette,
  scroll = 0,
): string[] {
  const safeWidth = Math.max(4, width);
  const safeHeight = Math.max(3, height);
  const innerWidth = safeWidth - 2;
  const border = focused ? palette.borderActive : palette.border;
  const titleWidth = Math.min(innerWidth - 1, visibleWidth(title));
  const clippedTitle = truncateToWidth(title, Math.max(0, titleWidth), "…");
  const remainder = Math.max(0, innerWidth - visibleWidth(clippedTitle) - 2);
  const top = `${border("┌─")} ${clippedTitle}${border("─".repeat(remainder) + "┐")}`;
  const capacity = safeHeight - 2;
  const start = Math.min(Math.max(0, scroll), Math.max(0, content.length - capacity));
  const body = content.slice(start, start + capacity).map((line) =>
    `${border("│")}${truncateToWidth(line, innerWidth, "…", true)}${border("│")}`,
  );
  while (body.length < capacity) body.push(`${border("│")}${" ".repeat(innerWidth)}${border("│")}`);
  return [padLine(top, safeWidth), ...body, border(`└${"─".repeat(innerWidth)}┘`)];
}

function framedHeader(title: string, metadata: string, width: number, palette: KoniPalette): string[] {
  const inner = Math.max(1, width - 2);
  return [
    `${palette.border("┌")} ${truncateToWidth(title, inner - 1, "…", true)}${palette.border("┐")}`,
    `${palette.border("│")}${truncateToWidth(` ${metadata}`, inner, "…", true)}${palette.border("│")}`,
    palette.border(`└${"─".repeat(inner)}┘`),
  ].map((line) => padLine(line, width));
}

function detailsTitle(snapshot: ControlCenterControllerSnapshot, palette: KoniPalette): string {
  const active = snapshot.selection.detailsTab;
  const label = (id: "overview" | "plan" | "stages" | "chat", title: string): string =>
    id === active ? palette.text(title) : palette.muted(title);
  const tabs = [label("overview", "Overview"), label("plan", "Plan"), label("stages", "Stages")];
  if (snapshot.selection.attemptId !== undefined) tabs.push(label("chat", "Chat"));
  return `${palette.muted("Details:")} ${tabs.join(palette.muted(" - "))}`;
}

function equalColumns(width: number, count: number): number[] {
  const base = Math.floor(width / count);
  const remainder = width % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function joinColumns(columns: readonly string[][], widths: readonly number[], height: number): string[] {
  return Array.from({ length: height }, (_, row) => columns.map((column, index) =>
    padLine(column[row] ?? "", widths[index]!),
  ).join(""));
}

function fitRows(lines: readonly string[], width: number, rows: number): string[] {
  const output = lines.slice(0, rows).map((line) => padLine(line, width));
  while (output.length < rows) output.push(" ".repeat(width));
  return output;
}

function padLine(line: string, width: number): string {
  return truncateToWidth(line, width, "", true);
}

function wrapStyled(value: string, width: number, style: (line: string) => string): string[] {
  return wrapTextWithAnsi(value, Math.max(1, width)).map(style);
}

function sectionHeading(title: string, palette: KoniPalette): string {
  return palette.bold(palette.text(title));
}

function centeredDivider(title: string, width: number, palette: KoniPalette): string {
  const label = ` ${title} `;
  const remaining = Math.max(0, width - visibleWidth(label));
  const left = Math.floor(remaining / 2);
  return `${palette.border("─".repeat(left))}${palette.muted(label)}${palette.border("─".repeat(remaining - left))}`;
}

function centeredButton(label: string, selected: boolean, palette: KoniPalette): string {
  const button = `  ${label}  `;
  const rendered = selected ? palette.selected(button) : palette.border(`[${button}]`);
  return `${" ".repeat(Math.max(0, 20 - Math.floor(visibleWidth(button) / 2)))}${rendered}`;
}

function selectorBadge(
  value: string,
  selected: boolean,
  palette: KoniPalette,
  color: (value: string, palette: KoniPalette) => string = modelStyle,
): string {
  const rendered = color(value, palette);
  return selected ? palette.selected(` ${rendered} `) : palette.border(`[${rendered}]`);
}

function selectorWindow(
  labels: readonly string[],
  selected: number,
  width: number,
  palette: KoniPalette,
): string {
  if (labels.length === 0) return "";
  let start = Math.max(0, Math.min(selected, labels.length - 1));
  let end = start + 1;
  const render = (from: number, to: number): string => {
    const body = labels.slice(from, to)
      .map((label, offset) => selectorBadge(label, from + offset === selected, palette))
      .join(" ");
    return `${from > 0 ? `${palette.muted("…")} ` : ""}${body}${to < labels.length ? ` ${palette.muted("…")}` : ""}`;
  };
  while (start > 0 || end < labels.length) {
    const growLeft = start > 0 && (end >= labels.length || selected - start <= end - selected - 1);
    const nextStart = growLeft ? start - 1 : start;
    const nextEnd = growLeft ? end : end + 1;
    if (visibleWidth(render(nextStart, nextEnd)) > width) break;
    start = nextStart;
    end = nextEnd;
  }
  return truncateToWidth(render(start, end), width, "");
}

function wrapSegments(segments: readonly string[], width: number): string[] {
  if (segments.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const segment of segments) {
    const candidate = line.length === 0 ? segment : `${line} ${segment}`;
    if (line.length > 0 && visibleWidth(candidate) > width) {
      lines.push(line);
      line = truncateToWidth(segment, width, "", true);
    } else {
      line = truncateToWidth(candidate, width, "", true);
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

function boundedWrapped(
  value: string,
  width: number,
  rows: number,
  style: (value: string) => string,
): string[] {
  const wrapped = wrapStyled(value, width, style);
  if (wrapped.length <= rows) return wrapped;
  const visible = wrapped.slice(0, Math.max(1, rows));
  visible[visible.length - 1] = truncateToWidth(
    `${visible[visible.length - 1]}…`,
    width,
    "…",
    true,
  );
  return visible;
}

/** Form values stay visibly filled even when another control owns focus. */
function inputBadge(
  value: string,
  selected: boolean,
  palette: KoniPalette,
  color: (value: string, palette: KoniPalette) => string = modelStyle,
): string {
  const body = palette.selected(` ${color(value, palette)} `);
  return selected ? palette.bold(`${palette.accent("›")} ${body}`) : `  ${body}`;
}

function selectorLine(label: string, value: string, selected: boolean, palette: KoniPalette): string {
  return `${selected ? palette.accent("›") : " "} ${label}: ${inputBadge(value, selected, palette)}`;
}

function runTypeBadge(value: string, selected: boolean, palette: KoniPalette): string {
  return selectorBadge(value, selected, palette, modelStyle);
}

function questionBadge(value: string, selected: boolean, palette: KoniPalette): string {
  const label = value === "none" ? "no" : value;
  const color = (text: string): string => value === "none" ? palette.muted(text)
    : value === "some" ? palette.info(text) : palette.warning(text);
  const badge = color(` ${label} `);
  return selected ? palette.selected(badge) : palette.border(`[${badge}]`);
}

function statusText(status: string, palette: KoniPalette): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("fail") || normalized.includes("block")) return palette.error(status);
  if (normalized.includes("complete")) return palette.success(status);
  if (normalized.includes("run") || normalized.includes("active")) return palette.accent(`⚙ ${status}`);
  return palette.muted(status);
}

function transcriptHeading(kind: string, title: string, palette: KoniPalette): string {
  if (kind === "user") return palette.accent(title);
  if (kind === "assistant") return palette.bold(title);
  if (kind === "thinking" || kind === "compaction") return palette.muted(title);
  if (kind === "tool_result") return palette.success(`✓ ${title}`);
  if (kind === "tool_call") return palette.info(`↳ ${title}`);
  return palette.warning(title);
}

function recentActivityTitle(duration: string | undefined, width: number): string {
  if (duration === undefined) return "Recent Activity";
  const full = `Recent Activity · ${duration} active`;
  if (visibleWidth(full) <= width) return full;
  const compact = `Activity · ${duration.replace(/\s+/gu, "")}`;
  return visibleWidth(compact) <= width ? compact : "Activity";
}

function footerHelp(width: number): string {
  const candidates = [
    "[n] new  [c] configure  [v] review  [Tab] panels  [↑↓/jk] move  [←→/[]] tabs  [Space] pause  [m] merge  [d] delete  [h] help  [q] close",
    "[n] new  [c] config  [v] review  [Tab] panels  [↑↓/jk] move  [Space] pause  [h] help  [q] close",
    "[n] new  [c] config  [Tab] panels  [↑↓] move  [h] help  [q] close",
  ];
  return candidates.find((candidate) => visibleWidth(candidate) <= width) ?? "[n] new  [c] config  [h] help  [q] close";
}

function modalEditingText(snapshot: ControlCenterControllerSnapshot): boolean {
  const modal = snapshot.modal;
  return modal?.kind === "new_run" && modal.focus === "objective"
    || modal?.kind === "plan_review" && modal.focus === "steering"
    || modal?.kind === "configure" && (modal.editing || modal.resourceOperation?.focus === "name");
}

function configValueLabel(
  field: ConfigFieldDefinition,
  value: unknown,
  models: readonly { provider: string; id: string; name: string }[],
): string {
  if (field.kind === "model" && typeof value === "string") {
    const split = value.indexOf("/");
    const provider = split < 0 ? "" : value.slice(0, split);
    const id = split < 0 ? value : value.slice(split + 1);
    return models.find((model) => model.provider === provider && model.id === id)?.name ?? id;
  }
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.length === 0 ? "Empty" : value.replace(/\s+/gu, " ");
  if (Array.isArray(value)) return value.join(", ");
  return "Not set";
}

function configuredModelOption(
  value: string,
  models: readonly ControlModelOption[],
): ControlModelOption | undefined {
  const split = value.indexOf("/");
  if (split < 0) return undefined;
  return models.find((model) => model.provider === value.slice(0, split) && model.id === value.slice(split + 1));
}

function selectedModelWarning(
  modal: NewRunModalState,
  models: readonly ControlModelOption[],
): string | undefined {
  return sealedModelAdmissionIssue(modal.roles, models)?.message;
}

function isConfigTextField(field: ConfigFieldDefinition): boolean {
  return field.kind === "text" || field.kind === "multiline" || field.kind === "string_list";
}

function visibleOffset(current: number, selectedLine: number, capacity: number): number {
  if (selectedLine < current) return selectedLine;
  if (selectedLine >= current + capacity) return Math.max(0, selectedLine - capacity + 2);
  return current;
}

function activeRun(state: string): boolean {
  return !new Set(["Draft", "Paused", "Blocked", "Failed", "Completed", "Deleted", "Merge Ready", "Awaiting Approval"]).has(state);
}

function statusStyle(marker: string, status: string, palette: KoniPalette): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("fail") || normalized.includes("block")) return palette.error(marker);
  if (normalized.includes("complete") || normalized.includes("ready")) return palette.success(marker);
  if (normalized.includes("approval") || normalized.includes("pause")) return palette.warning(marker);
  if (marker === "⚙") return palette.accent(marker);
  return palette.muted(marker);
}

function modelStyle(model: string, palette: KoniPalette): string {
  const styles = [palette.accent, palette.info, palette.success, palette.warning] as const;
  const hash = Array.from(model).reduce((total, character) => total + character.codePointAt(0)!, 0);
  return styles[hash % styles.length]!(model);
}

function thinkingStyle(level: string, palette: KoniPalette): string {
  switch (level.toLowerCase()) {
    case "off": return palette.muted(level);
    case "minimal": return palette.dim(level);
    case "low": return palette.success(level);
    case "medium": return palette.info(level);
    case "high": return palette.accent(level);
    case "xhigh": return palette.warning(level);
    case "max": return palette.error(level);
    default: return palette.text(level);
  }
}

function activityStyle(kind: string, message: string, palette: KoniPalette): string {
  if (kind === "graph_added") return palette.success(message);
  if (kind === "graph_modified") return palette.warning(message);
  if (kind === "graph_deleted") return palette.error(message);
  if (kind === "agent") return palette.info(message);
  if (kind === "git") return palette.accent(message);
  return palette.text(message);
}

/**
 * Compact layered graph inspired by autoresearch-v2: relationships are drawn first and node
 * markers/titles replace the cells beneath them. This keeps the topology visible without boxes,
 * IDs, or relationship prose fighting the graph.
 */
export function renderGraphLines(
  nodes: readonly GraphNodeView[],
  edges: readonly { source: string; target: string }[],
  width: number,
  palette: KoniPalette,
): string[] {
  if (nodes.length === 0 || width < 3) return [];
  const ordered = [...nodes].sort((left, right) => left.id.localeCompare(right.id));
  const byId = new Map(ordered.map((node) => [node.id, node]));
  const depth = new Map(ordered.map((node) => [node.id, 0]));
  for (let pass = 0; pass < ordered.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
      const next = Math.min(6, (depth.get(edge.source) ?? 0) + 1);
      if (next > (depth.get(edge.target) ?? 0) && next <= pass + 1) {
        depth.set(edge.target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rows = ordered.length * 2 - 1;
  const canvas = Array.from({ length: rows }, () => Array.from({ length: width }, () => " "));
  const positions = new Map<string, { x: number; y: number }>();
  ordered.forEach((node, index) => {
    const x = Math.min(Math.max(0, width - 2), 1 + (depth.get(node.id) ?? 0) * 4);
    positions.set(node.id, { x, y: index * 2 });
  });
  for (const edge of edges) {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (source === undefined || target === undefined) continue;
    const bendY = source.y;
    drawHorizontal(canvas, bendY, source.x, target.x);
    drawVertical(canvas, target.x, bendY, target.y);
  }
  const overlays = new Map<number, { start: number; markerEnd: number; titleEnd: number; muted: boolean }[]>();
  for (const node of ordered) {
    const position = positions.get(node.id)!;
    const marker = node.marker.slice(0, 2);
    const label = ` ${node.label}`;
    write(canvas, position.y, position.x, marker + label);
    const rowsForY = overlays.get(position.y) ?? [];
    rowsForY.push({
      start: position.x,
      markerEnd: position.x + marker.length,
      titleEnd: Math.min(width, position.x + marker.length + label.length),
      muted: node.muted,
    });
    overlays.set(position.y, rowsForY);
  }
  return canvas.map((cells, y) => {
    const ranges = overlays.get(y) ?? [];
    let output = "";
    let mode: "edge" | "marker" | "title" | "muted-title" = "edge";
    let segment = "";
    const flush = (): void => {
      if (segment.length === 0) return;
      output += mode === "marker" ? palette.bold(palette.accent(segment))
        : mode === "title" ? palette.muted(segment)
          : mode === "muted-title" ? palette.dim(segment)
            : palette.border(segment);
      segment = "";
    };
    cells.forEach((cell, x) => {
      const range = ranges.find((candidate) => x >= candidate.start && x < candidate.titleEnd);
      const nextMode = range === undefined ? "edge"
        : x < range.markerEnd ? "marker"
          : range.muted ? "muted-title" : "title";
      if (nextMode !== mode) {
        flush();
        mode = nextMode;
      }
      segment += cell;
    });
    flush();
    return truncateToWidth(output.trimEnd(), width, "…");
  });
}

function drawHorizontal(canvas: string[][], y: number, from: number, to: number): void {
  const left = Math.min(from, to);
  const right = Math.max(from, to);
  for (let x = left; x <= right; x += 1) mergeCell(canvas, y, x, "─");
}

function drawVertical(canvas: string[][], x: number, from: number, to: number): void {
  const top = Math.min(from, to);
  const bottom = Math.max(from, to);
  for (let y = top; y <= bottom; y += 1) mergeCell(canvas, y, x, "│");
}

function mergeCell(canvas: string[][], y: number, x: number, value: string): void {
  const row = canvas[y];
  if (row === undefined || x < 0 || x >= row.length) return;
  const previous = row[x];
  row[x] = previous === " " || previous === value ? value : "┼";
}

function write(canvas: string[][], y: number, x: number, value: string): void {
  const row = canvas[y];
  if (row === undefined) return;
  Array.from(value).forEach((character, offset) => {
    if (x + offset < row.length) row[x + offset] = character;
  });
}

function overlayModal(base: readonly string[], modal: readonly string[], width: number): string[] {
  const output = [...base];
  const modalWidth = Math.min(width, Math.max(...modal.map(visibleWidth), 1));
  const left = Math.max(0, Math.floor((width - modalWidth) / 2));
  const top = Math.max(0, Math.floor((base.length - modal.length) / 2));
  modal.forEach((line, index) => {
    output[top + index] = `${" ".repeat(left)}${truncateToWidth(line, modalWidth, "", true)}${" ".repeat(Math.max(0, width - left - modalWidth))}`;
  });
  return output;
}

const HELP: Readonly<Record<ControlCenterHelpTopic, {
  title: string;
  description: string;
  actions: readonly (readonly [string, string])[];
}>> = {
  runs: {
    title: "Runs",
    description: "Each run is a durable, isolated execution against the target branch shown in its row. Koni plans and works in its run worktree; only you publish a merge-ready result.",
    actions: [["↑/↓ or j/k", "select run"], ["Space", "pause or resume"], ["m", "merge a ready run"], ["d", "stop and delete"]],
  },
  tickets: {
    title: "Tickets",
    description: "The compiler derives tickets from the typed graph. Selecting one filters Agents and Graph to that ticket; Esc returns to the run-wide view.",
    actions: [["↑/↓ or j/k", "select ticket"], ["Esc", "clear ticket filter"]],
  },
  details: {
    title: "Details",
    description: "Overview keeps Objective, Goal, Run, and Evidence together. Plan shows live planning activity until submission, then the durable human-readable plan. Stages shows pipeline progress.",
    actions: [["←/→ or [ ]", "switch tab"], ["↑/↓ or j/k", "scroll"], ["Enter/o", "expand objective"]],
  },
  questions: {
    title: "Questions",
    description: "Pending questions pause the responsible attempt. Choose an option or None of these, optionally add notes, then send the combined answer.",
    actions: [["↑/↓", "choose option"], ["←/→", "switch question"], ["n or Tab", "edit notes"], ["Enter", "send answer"]],
  },
  agents: {
    title: "Agents",
    description: "Active and past attempts remain visible. Run-wide rows include their ticket prefix; selecting a ticket narrows the list. Inactive Lead attempts are retained.",
    actions: [["↑/↓ or j/k", "select attempt"], ["Enter", "open attempt chat"], ["Esc", "leave chat"]],
  },
  activity: {
    title: "Recent Activity",
    description: "This durable feed combines compiler, graph, Git, and agent events. Green adds graph knowledge, yellow changes it, red deletes it, and timestamps show when each event happened.",
    actions: [["↑/↓ or j/k", "scroll"], ["PgUp/PgDn", "scroll a page"]],
  },
  graph: {
    title: "Graph",
    description: "The typed context graph is Koni's shared specification. Markers replace relationship lines at each node, while concise muted titles preserve topology without IDs or dense prose.",
    actions: [["↑/↓ or j/k", "scroll"], ["PgUp/PgDn", "scroll a page"]],
  },
  new_run: {
    title: "New Run",
    description: "A run pins one target branch, run type, and set of run-local overrides. Skipped stages remain visible in muted text; publishing the form asks authority to validate everything again and immediately creates a provisional Runs row.",
    actions: [["Tab or ↑/↓", "move between controls"], ["←/→", "change a selector"], ["PgUp/PgDn", "inspect every stage"], ["Enter", "newline, select, or start"]],
  },
  plan_review: {
    title: "Review Plan",
    description: "The four sections are independently authored concise review summaries. Empty steering approves; any steering changes the one action to Revise. After approval, Details → Plan keeps the complete Markdown plans available.",
    actions: [["←/→ or [ ]", "switch section"], ["↑/↓ or j/k", "scroll"], ["Tab", "move document/editor/action"], ["Ctrl-Enter", "perform the adaptive action"]],
  },
  configure: {
    title: "Configure",
    description: "Guided domains edit an in-memory project-overlay draft. Koni never makes YAML the primary interface. Publish sends the complete candidate and source-CAS token to authority; active and pinned runs are unchanged by a draft.",
    actions: [["←/→", "change section, value, or action"], ["↑/↓", "choose resource or field"], ["a / d / x", "add, duplicate, or delete resource"], ["Ctrl-S", "save in-memory draft"], ["Ctrl-R", "rebase a stale saved draft"], ["Ctrl-P", "validate and publish"], ["Ctrl-D", "discard draft"]],
  },
  chat: {
    title: "Agent Chat",
    description: "This is the persisted Pi session itself: complete assistant messages, reasoning, calls, results, compaction, and branch points. Steering and follow-ups still cross Koni authority before Pi receives them.",
    actions: [["Enter or s", "open the composer"], ["Tab", "switch steer/follow-up"], ["Ctrl-Enter", "send through authority"], ["Esc", "finish composing or leave chat"]],
  },
};
