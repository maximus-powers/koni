import type { Theme } from "@earendil-works/pi-coding-agent";
import { CONFIG_DOCUMENT_DOMAINS } from "../authority/config-documents.js";
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
  decodeControlCenterPointer,
  decodeControlCenterInput,
  type ControlCenterPanel,
  type ControlCenterPointerInput,
} from "./input.js";
import {
  ansiKoniPalette,
  type KoniPalette,
  paletteFromPiTheme,
  renderKoniMarkdown,
} from "./markdown.js";
import type { ControlIntakeField, ControlRunTypeOption } from "./protocol.js";
import { isCreatingNewTarget, runTargetSelectedLabel } from "./run-target.js";
import {
  type ControlCenterController,
  type ControlCenterControllerSnapshot,
  type AnswerQuestionModalState,
  type ActionFormModalState,
  type ActionPaletteModalState,
  type ConfigureModalState,
  type ConfigureDocumentsModalState,
  type ConfigDocumentCreateModalState,
  type ConfigDocumentRenameModalState,
  type ConfigDocumentDeleteModalState,
  type ConfigRunTypeWizardModalState,
  type ConfigLegacyMigrationModalState,
  type ControlCenterHelpTopic,
  type EditScalarModalState,
  configResourceActions,
  type DeleteRunModalState,
  type MergeRunModalState,
  type NewRunModalState,
  type PlanReviewModalState,
  type ProposalReviewModalState,
  type ProfileConflictsModalState,
  selectedConfigField,
} from "./controller.js";
import type { ConfigFieldDefinition, ControlModelOption } from "./protocol.js";
import { CellGrid } from "./cell-grid.js";
import {
  CONTROL_CENTER_MIN_HEIGHT,
  CONTROL_CENTER_MIN_WIDTH,
  configureLayout,
  operateLayout,
  type ConfigureLayout as ConfigureScreenLayout,
  type OperateLayout,
} from "./layout.js";
import {
  cockpitBooleanOption,
  cockpitIntegerOption,
  cockpitStringArrayMapOption,
  cockpitStringArrayOption,
  cockpitStringMapOption,
  cockpitView,
  type CompiledCockpitView,
} from "./cockpit-config.js";

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
  #lastFrame: CellGrid | undefined;
  #animationFrame = 0;

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
      if (!hasAnimatedWork(this.#snapshot)) return;
      this.#animationFrame = (this.#animationFrame + 1) % 4;
      this.#requestRender?.();
    }, 500);
    this.#ticker?.unref();
  }

  public handleInput(data: string): void {
    const pointer = decodeControlCenterPointer(data);
    if (pointer !== undefined) {
      this.#handlePointer(pointer);
      return;
    }
    const action = decodeControlCenterInput(data, {
      panel: this.#snapshot.focus,
      editingNotes: this.#snapshot.questionDraft?.editingNotes ?? false,
      modalOpen: this.#snapshot.modal !== undefined,
      ...(this.#snapshot.modal === undefined ? {} : { modalKind: this.#snapshot.modal.kind }),
      editingText: modalEditingText(this.#snapshot),
      chatComposer: this.#snapshot.chat?.draft.editing ?? false,
      chatOpen: this.#snapshot.selection.detailsTab === "chat",
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
    return this.renderFrame(width, this.#viewportRows()).toAnsiLines();
  }

  /** Deterministic glyph/style/region projection shared by Pi, standalone, and oracle tests. */
  public renderFrame(width: number, rows = this.#viewportRows()): CellGrid {
    this.#snapshot = this.#controller.snapshot;
    const safeWidth = Math.max(1, width);
    const safeRows = Math.max(1, rows);
    const showQuestions = (this.#snapshot.view.selectedRun?.questions?.length ?? 0) > 0;
    const layout = operateLayout(safeWidth, safeRows, showQuestions);
    if (layout.kind === "resize") {
      const frame = CellGrid.fromAnsiLines(
        resizeScreen(safeWidth, safeRows, this.#palette),
        safeWidth,
        safeRows,
      );
      this.#lastFrame = frame.addRegion("resize", layout.screen);
      return this.#lastFrame;
    }

    const configure = this.#snapshot.configureSurface;
    if (configure !== undefined) {
      const configureGeometry = configureLayout(safeWidth, safeRows);
      if (configureGeometry.kind === "resize") {
        this.#lastFrame = CellGrid.fromAnsiLines(resizeScreen(safeWidth, safeRows, this.#palette), safeWidth, safeRows)
          .addRegion("resize", configureGeometry.screen);
        return this.#lastFrame;
      }
      let configured = configure.kind === "configure"
        ? this.#renderConfigureScreen(configure, configureGeometry)
        : this.#renderConfigureDocumentsScreen(configure, configureGeometry);
      if (this.#snapshot.modal?.kind === "profile_conflicts") {
        configured = overlayModal(
          configured,
          this.#renderProfileConflicts(
            this.#snapshot.modal,
            Math.max(24, Math.min(118, safeWidth - 4)),
            Math.max(12, safeRows - 4),
          ),
          safeWidth,
        );
      } else if (configure.kind === "configure" && configure.resourceOperation !== undefined) {
        configured = overlayModal(
          configured,
          this.#renderConfigResourceOperation(
            configure,
            Math.max(24, Math.min(84, safeWidth - 8)),
            Math.max(12, safeRows - 6),
          ),
          safeWidth,
        );
      } else if (this.#snapshot.modal !== undefined && this.#snapshot.modal.kind !== configure.kind) {
        configured = overlayModal(
          configured,
          this.#renderModal(
            Math.max(24, Math.min(118, safeWidth - 4)),
            Math.max(12, safeRows - 4),
          ),
          safeWidth,
        );
      }
      const frame = CellGrid.fromAnsiLines(fitRows(configured, safeWidth, safeRows), safeWidth, safeRows);
      frame.addRegion("header", configureGeometry.header);
      frame.addRegion("config.domains", configureGeometry.domains, "config:domains");
      frame.addRegion("config.resources", configureGeometry.resources, "config:resources");
      frame.addRegion("config.editor", configureGeometry.editor, "config:editor");
      frame.addRegion("config.draft", configureGeometry.draftBar, "config:draft");
      frame.addRegion("footer", configureGeometry.footer);
      if (this.#snapshot.modal !== undefined && this.#snapshot.modal.kind !== configure.kind ||
          configure.kind === "configure" && configure.resourceOperation !== undefined) {
        frame.addHitTarget("modal", { x: 0, y: 0, width: safeWidth, height: safeRows });
      }
      if (configure.kind === "configure") annotateConfigureHitTargets(frame, configureGeometry, this.#snapshot, configure);
      else annotateConfigureDocumentHitTargets(frame, configureGeometry, this.#snapshot, configure);
      this.#lastFrame = frame;
      return frame;
    }

    const rendered = this.#renderOperate(layout);
    const withModal = this.#snapshot.modal === undefined
      ? rendered
      : overlayModal(
        rendered,
        this.#renderModal(
          Math.max(24, Math.min(118, safeWidth - 4)),
          Math.max(12, safeRows - 4),
        ),
        safeWidth,
      );
    const frame = CellGrid.fromAnsiLines(
      fitRows(withModal, safeWidth, safeRows),
      safeWidth,
      safeRows,
    );
    frame.addRegion("header", layout.header);
    frame.addRegion("runs", layout.runs, "panel:runs");
    frame.addRegion("tickets", layout.tickets, "panel:tickets");
    frame.addRegion("agents", layout.agents, "panel:agents");
    frame.addRegion("details", layout.details, "panel:details");
    if (layout.questions !== undefined) frame.addRegion("questions", layout.questions, "panel:questions");
    frame.addRegion("activity", layout.activity, "panel:activity");
    frame.addRegion("graph", layout.graph, "panel:graph");
    frame.addRegion("footer", layout.footer);
    annotateOperateHitTargets(frame, layout, this.#snapshot);
    if (this.#snapshot.modal !== undefined) {
      frame.addHitTarget("modal", { x: 0, y: 0, width: safeWidth, height: safeRows });
      annotateModalHitTargets(frame, this.#snapshot);
    } else {
      annotateOperateControlHitTargets(frame, layout, this.#snapshot);
    }
    this.#lastFrame = frame;
    return frame;
  }

  #handlePointer(pointer: ControlCenterPointerInput): void {
    const target = this.#lastFrame?.hitTargetAt(pointer.x, pointer.y);
    if (target === undefined) return;
    const panel = panelFromHitTarget(target);
    if (pointer.kind === "wheel") {
      if (panel !== undefined) void this.#controller.handle({ type: "pointer_scroll", panel, delta: pointer.delta });
      return;
    }
    if (pointer.kind !== "press" || pointer.button !== "left") return;
    if (target.startsWith("run:")) {
      void this.#controller.handle({ type: "select_run", runId: target.slice(4) });
    } else if (target.startsWith("ticket:")) {
      void this.#controller.handle({ type: "select_ticket", ticketId: target.slice(7) });
    } else if (target.startsWith("agent:")) {
      void this.#controller.handle({ type: "select_agent", attemptId: target.slice(6) });
    } else if (panel !== undefined) {
      void this.#controller.handle({ type: "focus_panel", panel });
    } else if (target !== "modal") {
      void this.#controller.handle({ type: "pointer_control", target });
    }
  }

  #renderOperate(layout: OperateLayout): string[] {
    const left = [
      ...this.#runsPanel(layout.runs.width, layout.runs.height),
      ...this.#ticketsPanel(layout.tickets.width, layout.tickets.height),
      ...this.#agentsPanel(layout.agents.width, layout.agents.height),
    ];
    const middle = layout.questions === undefined
      ? this.#detailsPanel(layout.details.width, layout.details.height)
      : [
        ...this.#detailsPanel(layout.details.width, layout.details.height),
        ...this.#questionsPanel(layout.questions.width, layout.questions.height),
      ];
    const right = [
      ...this.#activityPanel(layout.activity.width, layout.activity.height),
      ...this.#graphPanel(layout.graph.width, layout.graph.height),
    ];
    const bodyHeight = layout.footer.y - layout.header.height;
    return [
      ...this.#header(layout.width),
      ...joinColumns(
        [left, middle, right],
        [layout.runs.width, layout.details.width, layout.activity.width],
        bodyHeight,
      ),
      ...this.#footer(layout.width),
    ];
  }

  #header(width: number, mode: "OPERATE" | "CONFIGURE" | "PROJECT RESOURCES" = "OPERATE"): string[] {
    const run = this.#snapshot.view.selectedRun;
    const metadata = run === undefined
      ? this.#palette.muted("No runs yet")
      : [
        this.#palette.accent(run.header.runType),
        `${run.spendingTokens ? `${this.#animatedCog()} ` : ""}${run.header.stage}`,
        `${run.header.ticketCount} tickets`,
        run.header.newTokens,
        ...(run.header.awaitingApproval ? [this.#palette.warning("approval needed")] : []),
        ...(this.#snapshot.cockpitIssue === undefined ? [] : [this.#palette.warning("view config unavailable")]),
      ].join(this.#palette.muted(" · "));
    const title = `${this.#palette.bold(this.#palette.accent(" KONI "))} ${this.#palette.accent(mode)} ${this.#palette.text(`project:${this.#snapshot.view.projectRoot}`)}`;
    return framedHeader(title, metadata, width, this.#palette);
  }

  #renderConfigureScreen(modal: ConfigureModalState, layout: ConfigureScreenLayout): string[] {
    const section = modal.catalog.sections[modal.sectionIndex];
    const resource = section?.resources[modal.resourceIndex];
    const domains = modal.catalog.sections.map((candidate, index) => {
      const row = `${configDomainGlyph(candidate.id)} ${candidate.title}`;
      return index === modal.sectionIndex ? this.#palette.selected(`› ${row}`) : `  ${this.#palette.muted(row)}`;
    });
    const resources = (section?.resources ?? []).map((candidate, index) => {
      const indent = "  ".repeat(Math.max(0, candidate.depth ?? 0));
      const branch = index === (section?.resources.length ?? 0) - 1 ? "└" : "├";
      const row = `${indent}${branch} ${candidate.title}`;
      return index === modal.resourceIndex ? this.#palette.selected(`› ${row}`) : `  ${this.#palette.muted(row)}`;
    });
    if (resources.length === 0) resources.push(this.#palette.muted("No resources in this domain."));

    const editor: string[] = [];
    if (modal.upstreamConflicts.conflicts.length > 0) {
      editor.push(this.#palette.warning(
        `${modal.upstreamConflicts.conflicts.length} upstream ${modal.upstreamConflicts.conflicts.length === 1 ? "change needs" : "changes need"} review · [u] Open comparison`,
      ), "");
    }
    if (resource === undefined) editor.push(this.#palette.muted("Select a resource to inspect its settings."));
    else {
      editor.push(sectionHeading(resource.title, this.#palette));
      editor.push(...wrapStyled(resource.description, Math.max(1, layout.editor.width - 2), this.#palette.muted), "");
      resource.fields.forEach((field, index) => {
        const selected = index === modal.fieldIndex;
        const value = configValueLabel(field, modal.draft[field.key], this.#snapshot.models);
        const row = `${selected ? "›" : " "} ${field.label}  ${inputBadge(value, selected && modal.focus === "field", this.#palette)}`;
        editor.push(selected ? this.#palette.text(row) : this.#palette.muted(row));
        if (selected) {
          editor.push(...wrapStyled(field.description, Math.max(1, layout.editor.width - 5), (line) => `   ${this.#palette.dim(line)}`));
          if (isConfigTextField(field)) {
            const source = modal.textEditor?.key === field.key
              ? modal.textEditor.value
              : modal.draft[field.key];
            const valueText = typeof source === "string" ? source
              : Array.isArray(source) ? source.filter((item): item is string => typeof item === "string").join("\n")
                : "";
            editor.push(...wrapStyled(
              `${modal.editing ? "▌ " : "  "}${valueText.length === 0 ? this.#palette.dim("Empty") : valueText}`,
              Math.max(1, layout.editor.width - 4),
              (line) => selected ? this.#palette.selected(line) : line,
            ));
          }
        }
      });
      const resourceActions = configResourceActions(modal);
      if (resourceActions.length > 0) {
        editor.push("", resourceActions.map((action) => {
          if (action === "create") return "[a] Add";
          if (action === "duplicate") return "[d] Duplicate";
          return "[x] Delete";
        }).join("  "));
      }
    }

    const content = [
      ...this.#header(layout.width, "CONFIGURE"),
      ...joinColumns([
        panel("Domains", domains, layout.domains.width, layout.domains.height, modal.focus === "tree", this.#palette),
        panel(section?.title ?? "Resources", resources, layout.resources.width, layout.resources.height, modal.focus === "tree", this.#palette, visibleOffset(0, modal.resourceIndex, Math.max(1, layout.resources.height - 2))),
        panel("Editor", editor, layout.editor.width, layout.editor.height, modal.focus === "field" || modal.focus === "actions", this.#palette),
      ], [layout.domains.width, layout.resources.width, layout.editor.width], layout.domains.height),
      ...panel(
        modal.dirty ? "Draft · unpublished changes" : "Draft · configuration current",
        [centerLine(
          modal.rebaseRequired
            ? "Saved draft is stale · Ctrl-R rebase or Ctrl-D discard"
            : "[r] Project Resources   [Ctrl-S] Save draft   [Ctrl-P] Validate & publish   [Ctrl-D] Discard",
          Math.max(1, layout.width - 2),
          modal.rebaseRequired ? this.#palette.warning : this.#palette.accent,
        )],
        layout.draftBar.width,
        layout.draftBar.height,
        modal.focus === "publish",
        this.#palette,
      ),
      ...this.#footer(layout.width),
    ];
    return fitRows(content, layout.width, layout.height);
  }

  #renderConfigureDocumentsScreen(
    modal: ConfigureDocumentsModalState,
    layout: ConfigureScreenLayout,
  ): string[] {
    const domain = CONFIG_DOCUMENT_DOMAINS[modal.domainIndex] ?? CONFIG_DOCUMENT_DOMAINS[0];
    const documents = modal.catalog.documents.filter((document) => document.domain === domain);
    const selected = documents[modal.documentIndex];
    const domains = CONFIG_DOCUMENT_DOMAINS.map((candidate, index) => {
      const count = modal.catalog.documents.filter((document) => document.domain === candidate).length;
      const row = `${configDocumentDomainGlyph(candidate)} ${titleCaseLabel(candidate)} ${this.#palette.muted(String(count))}`;
      return index === modal.domainIndex ? this.#palette.selected(`› ${row}`) : `  ${this.#palette.muted(row)}`;
    });
    const resources = documents.map((document, index) => {
      const branch = index === documents.length - 1 ? "└" : "├";
      const lock = document.capabilities.update ? "" : ` ${this.#palette.muted("read only")}`;
      const row = `${branch} ${document.title}${lock}`;
      return index === modal.documentIndex ? this.#palette.selected(`› ${row}`) : `  ${this.#palette.muted(row)}`;
    });
    if (resources.length === 0) resources.push(this.#palette.muted("No resources in this domain."));

    const editor: string[] = [];
    let editorFocusLine = 0;
    if (!modal.catalog.valid) {
      editor.push(this.#palette.warning("Configuration needs repair; edit the exact source below."));
      editor.push(...modal.catalog.diagnostics.slice(0, 4).flatMap((diagnostic) =>
        wrapStyled(diagnostic, Math.max(1, layout.editor.width - 2), this.#palette.warning)), "");
    }
    if (selected === undefined || modal.source === undefined) {
      editor.push(this.#palette.muted("Select a resource to inspect its project-authored source."));
    } else {
      editor.push(
        sectionHeading(selected.title, this.#palette),
        `${this.#palette.muted(titleCaseLabel(selected.kind))} · ${selected.format.toUpperCase()} · ${formatBytes(selected.sizeBytes)}`,
      );
      if (selected.capabilities.reason !== undefined) editor.push(this.#palette.muted(selected.capabilities.reason));
      editor.push("");
      const source = modal.editing ? insertCaret(modal.draft, modal.cursor) : modal.draft;
      const sourceLines = source.split("\n");
      const numberWidth = Math.max(2, String(sourceLines.length).length);
      sourceLines.forEach((line, index) => {
        const prefix = `${String(index + 1).padStart(numberWidth)} │ `;
        const wrapped = wrapTextWithAnsi(line.length === 0 ? " " : line, Math.max(1, layout.editor.width - prefix.length - 2));
        wrapped.forEach((part, partIndex) => {
          if (part.includes("▌")) editorFocusLine = editor.length;
          editor.push(`${this.#palette.muted(partIndex === 0 ? prefix : " ".repeat(prefix.length))}${modal.editing ? this.#palette.text(part) : part}`);
        });
      });
    }

    const dirtyCopy = modal.dirty ? "Raw source · unpublished changes" : "Raw source · current";
    const content = [
      ...this.#header(layout.width, "PROJECT RESOURCES"),
      ...joinColumns([
        panel("Domains", domains, layout.domains.width, layout.domains.height, modal.focus === "domains", this.#palette),
        panel(titleCaseLabel(domain), resources, layout.resources.width, layout.resources.height, modal.focus === "documents", this.#palette, visibleOffset(0, modal.documentIndex, Math.max(1, layout.resources.height - 2))),
        panel(
          "Source Editor",
          editor,
          layout.editor.width,
          layout.editor.height,
          modal.focus === "editor",
          this.#palette,
          modal.editing
            ? visibleOffset(modal.scroll, editorFocusLine, Math.max(1, layout.editor.height - 2))
            : modal.scroll,
        ),
      ], [layout.domains.width, layout.resources.width, layout.editor.width], layout.domains.height),
      ...panel(
        dirtyCopy,
        [centerLine(
          modal.dirty
            ? "[Ctrl-S] Validate & save   [Ctrl-D] Discard   Esc stays here"
            : "[Enter] Edit   [a] New   [e] Rename   [x] Delete   [t] Run type   [l] Legacy migration   [Esc] Guided",
          Math.max(1, layout.width - 2),
          modal.dirty ? this.#palette.warning : this.#palette.accent,
        )],
        layout.draftBar.width,
        layout.draftBar.height,
        false,
        this.#palette,
      ),
      ...this.#footer(layout.width),
    ];
    return fitRows(content, layout.width, layout.height);
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

  #runsPanel(width: number, height: number): string[] {
    const lines: string[] = [];
    const page = this.#snapshot.view.runPage;
    const hiddenAbove = page.startIndex;
    const hiddenBelow = page.totalRuns - page.startIndex - page.visibleRuns;
    const pageTitle = page.totalRuns > page.visibleRuns
      ? `Runs ${page.startIndex + 1}–${page.startIndex + page.visibleRuns} of ${page.totalRuns}${
        hiddenAbove > 0 ? ` · ↑${hiddenAbove} more` : ""
      }${hiddenBelow > 0 ? ` · ↓${hiddenBelow} more` : ""}`
      : "Runs";
    let selectedLine = 0;
    for (const row of this.#snapshot.view.runs) {
      const selected = row.id === this.#snapshot.selection.runId;
      if (selected) selectedLine = lines.length;
      const marker = row.provisional || row.activeAgentCount > 0
        ? this.#animatedCog()
        : row.paused ? "Ⅱ" : row.mergeReady ? "◆" : "●";
      const primary = `${selected ? "›" : " "} ${statusStyle(marker, row.state, this.#palette)} ${row.title}`;
      const badges = [
        // Identity first: same-goal retries render identical titles, so the short id and age are
        // the only way to tell rows apart at a glance.
        this.#palette.muted(`#${row.shortId}`),
        this.#palette.muted(relativeAge(row.createdAt)),
        row.runType,
        row.stage,
        row.ticketProgress,
        ...(row.questionCount === 0 ? [] : [`${row.questionCount} Q`]),
        ...(row.proposalCount === 0 ? [] : [this.#palette.warning(`${row.proposalCount} proposal${row.proposalCount === 1 ? "" : "s"}`)]),
        ...(row.activeAgentCount === 0 ? [] : [`${row.activeAgentCount} working`]),
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
    return panelWithFooter(
      pageTitle,
      lines,
      this.#snapshot.view.runs.length === 0
        ? "[n] New run"
        : completeFooter([
            "[Space] pause/play · [v] review · [m] merge · [d] delete · [n] new",
            "[Space] pause/play · [v] review · [n] new",
            "[Space] pause/play",
          ], Math.max(1, width - 2)),
      width,
      height,
      this.#snapshot.focus === "runs",
      this.#palette,
      visibleOffset(this.#snapshot.scroll.runs, selectedLine, height - 2),
    );
  }

  #ticketsPanel(width: number, height: number): string[] {
    const selectedRun = this.#snapshot.view.selectedRun;
    const tickets = selectedRun?.tickets ?? [];
    const configured = cockpitView(this.#snapshot.view.cockpit, ["tabbed_table", "kanban"]);
    const configuredColumns = new Set(configured?.columns.map((column) => column.id) ?? []);
    const customColumns = configuredColumns.size > 0;
    const activeTab = selectedRun?.ticketTabs.find((tab) => tab.id === selectedRun.ticketTab);
    const lines: string[] = [
      centerLine(`‹ ${activeTab?.title ?? "All"} ${activeTab?.count ?? 0} ›`, Math.max(1, width - 2), this.#palette.accent),
    ];
    let selectedLine = 0;
    for (const ticket of tickets) {
      const selected = ticket.id === this.#snapshot.selection.ticketId;
      if (selected) selectedLine = lines.length;
      const marker = ticket.proposalAwaitingDecision ? "◆"
        : ticket.recovery ? "!" : ticket.active ? "⚙" : ticket.status === "Completed" ? "●" : "○";
      const line = `${selected ? "›" : " "} ${statusStyle(marker, ticket.status, this.#palette)} ${ticket.title}`;
      lines.push(selected ? this.#palette.selected(line) : line);
      const details = [
        ...(!customColumns || configuredColumns.has("operation") ? [ticket.status] : []),
        ...(!customColumns || configuredColumns.has("steps") ? [`${ticket.rail} ${ticket.progress}`] : []),
        ...((!customColumns || configuredColumns.has("agents")) && ticket.currentPersona !== undefined
          ? [this.#palette.info(ticket.currentPersona)] : []),
        ...(ticket.recovery ? [this.#palette.error("recovery needed")] : []),
        ...(ticket.proposalAwaitingDecision ? [this.#palette.warning("decision needed · Enter/p inspect")] : []),
      ];
      lines.push(`    ${details.join(this.#palette.muted(" · "))}`);
    }
    if (tickets.length === 0) lines.push(this.#palette.muted(`No ${(activeTab?.title ?? "visible").toLowerCase()} tickets.`));
    return panel(
      configured?.title ?? "Tickets",
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
    const configured = cockpitView(this.#snapshot.view.cockpit, ["nested_detail"]);
    const title = detailsTitle(this.#snapshot, this.#palette, configured?.title);
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
        if (run.plan.mode === "activity") {
          lines.push(
            run.spendingTokens
              ? this.#palette.accent(`${this.#animatedCog()} Planning is active`)
              : this.#palette.muted("○ Planning is waiting for compiler or agent work"),
            "",
          );
        }
        for (const section of run.plan.sections) {
          lines.push(sectionHeading(section.title, this.#palette));
          lines.push(...renderKoniMarkdown(section.markdown, width, this.#palette), "");
        }
        return lines;
      }
      case "stages":
        return run.stages.flatMap((stage, index) => {
          const marker = stage.state === "done" ? this.#palette.success("●")
            : stage.state === "active" && run.spendingTokens ? this.#palette.accent(this.#animatedCog())
              : stage.state === "active" ? this.#palette.accent("◐")
              : this.#palette.muted("○");
          const available = stage.actions.filter((action) => action.available);
          const disabled = stage.actions.filter((action) => !action.available);
          return [
            ...wrapStyled(`${marker} ${index + 1}. ${stage.title}`, width, (value) => value),
            ...(stage.state === "active" ? [this.#palette.muted(
              `   ${stage.category ?? "Current stage"} · ${stage.interaction?.mode ?? "automatic"}`,
            )] : []),
            ...(stage.summary === undefined ? [] : wrapStyled(stage.summary, Math.max(1, width - 3), (value) => `   ${this.#palette.warning(value)}`)),
            ...available.flatMap((action) => wrapStyled(
              `   [Enter] ${action.title} · ${action.reason}`,
              width,
              this.#palette.accent,
            )),
            ...(stage.state !== "active" || disabled.length === 0 ? [] : disabled.flatMap((action) => wrapStyled(
              `   ${action.title} unavailable · ${action.reason}`,
              width,
              this.#palette.muted,
            ))),
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
          ...(agent.lineage === undefined ? [] : [
            `${this.#palette.muted("Lineage")} ${agent.lineage.reason} · ${agent.lineage.branch}${agent.lineage.activeLeaf ? ` · ${this.#palette.success("active leaf")}` : ""}`,
            ...(agent.lineage.parent === undefined ? [] : [`${this.#palette.muted("Parent")} ${agent.lineage.parent}`]),
            ...(agent.lineage.children.length === 0 ? [] : [
              `${this.#palette.muted("Children")} ${agent.lineage.children.join(" · ")}`,
            ]),
          ]),
          ...(agent.active ? [] : [this.#palette.muted("Historical session · read-only")]),
        ];
        const chat = this.#snapshot.chat;
        if (chat === undefined || chat.status === "loading") lines.push("", this.#palette.accent("⚙ Loading Pi session…"));
        else if (chat.status === "unavailable") lines.push("", this.#palette.muted("This authority does not expose persisted Pi transcripts."));
        else if (chat.status === "error") lines.push("", this.#palette.error(chat.error ?? "Pi transcript could not be loaded."));
        else {
          const historyEnd = chat.history.startBlock + chat.history.visibleBlocks;
          const historyRange = chat.history.totalBlocks === 0
            ? "History is empty"
            : `History ${chat.history.startBlock + 1}–${historyEnd} of ${chat.history.totalBlocks}`;
          lines.push(
            "",
            this.#palette.muted(historyRange),
            ...wrapStyled(
              `${chat.history.hasOlder ? this.#palette.accent("[ older") : this.#palette.dim("[ oldest")} · ${chat.history.hasNewer ? this.#palette.accent("] newer") : this.#palette.dim("] newest")} · PgUp/PgDn scroll · r latest`,
              width,
              (line) => line,
            ),
          );
          for (const block of chat.blocks) {
            const chunk = block.chunk === undefined
              ? ""
              : ` · part ${block.chunk.index}/${block.chunk.total}`;
            lines.push("", transcriptHeading(block.kind, `${block.branch ? "↳ " : ""}${block.title}${chunk}`, this.#palette));
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
      this.#palette.muted(
        question.batchQuestionCount === undefined
          ? `${question.index}/${question.total}`
          : `${question.index}/${question.total} · ${question.batchAnsweredCount ?? 0}/${question.batchQuestionCount} saved`,
      ),
      ...wrapStyled(question.prompt, inner, this.#palette.bold),
      "",
    ];
    let selectedLine = 0;
    for (const option of question.options) {
      const selected = draft?.selectedOptionId === option.id;
      if (selected) selectedLine = lines.length;
      const recommended = question.recommendationOptionId === option.id ? ` ${this.#palette.warning("★")}` : "";
      const row = `${selected ? "●" : "○"} ${option.label}${recommended}`;
      lines.push(selected ? this.#palette.selected(row) : row);
      lines.push(...wrapStyled(option.description, Math.max(1, inner - 3), (value) => `   ${this.#palette.muted(value)}`));
    }
    const noneSelected = draft?.selectedOptionId === undefined;
    if (noneSelected) selectedLine = lines.length;
    lines.push(noneSelected ? this.#palette.selected("● None of the above") : "○ None of the above");
    if (question.allowsNotes) {
      lines.push("", centeredDivider("Notes (optional)", inner, this.#palette));
      const notes = draft?.notes ?? "";
      const noteText = notes.length === 0 ? this.#palette.dim("Add context to any answer…") : notes;
      lines.push(...wrapStyled(
        `${draft?.editingNotes === true ? "▌ " : "  "}${noteText}`,
        inner,
        (value) => draft?.editingNotes === true ? this.#palette.selected(value) : value,
      ));
    }
    if (question.answerSaved) lines.push("", this.#palette.success("Saved · submit again to revise"));
    return panelWithFooter(
      "Questions",
      lines,
      completeFooter(question.allowsNotes
        ? ["←→/[] · ↑↓/jk · Enter · [n] notes", "←→/[] ↑↓/jk Enter", "Enter"]
        : ["←→/[] · ↑↓/jk · Enter", "←→/[] ↑↓/jk Enter", "Enter"], Math.max(1, width - 2)),
      width,
      height,
      this.#snapshot.focus === "questions",
      this.#palette,
      visibleOffset(this.#snapshot.scroll.questions, selectedLine, height - 3),
    );
  }

  #agentsPanel(width: number, height: number): string[] {
    const configured = cockpitView(this.#snapshot.view.cockpit, ["status_overlay"]);
    const agents = this.#snapshot.view.selectedRun?.agents ?? [];
    const lines: string[] = [];
    let selectedLine = 0;
    for (const agent of agents) {
      const selected = agent.id === this.#snapshot.selection.attemptId;
      if (selected) selectedLine = lines.length;
      const marker = agent.active ? this.#palette.accent("⚙") : "●";
      const row = `${selected ? "›" : " "} ${marker} ${agent.label} · ${this.#palette.muted(agent.work)}`;
      lines.push(selected ? this.#palette.selected(row) : agent.active ? row : this.#palette.muted(row));
      const detail = `    ${modelStyle(agent.model, this.#palette)} · ${thinkingStyle(agent.thinking, this.#palette)} · ${agent.newTokens} new${agent.lineage === undefined ? "" : ` · ${agent.lineage.reason}${agent.lineage.activeLeaf ? " · leaf" : ""}`}`;
      lines.push(agent.active ? detail : this.#palette.dim(detail));
    }
    if (lines.length === 0) lines.push(this.#palette.muted("No agent attempts yet."));
    return panel(configured?.title ?? "Agents", lines, width, height, this.#snapshot.focus === "agents", this.#palette, visibleOffset(this.#snapshot.scroll.agents, selectedLine, height - 2));
  }

  #activityPanel(width: number, height: number): string[] {
    const run = this.#snapshot.view.selectedRun;
    const configured = cockpitView(this.#snapshot.view.cockpit, ["summary"]);
    const title = recentActivityTitle(run?.activeDuration, Math.max(1, width - 2), configured?.title);
    const eventLimit = cockpitIntegerOption(configured, "event_limit");
    const activity = eventLimit === undefined ? run?.activity : run?.activity.slice(0, eventLimit);
    const lines = activity?.flatMap((activity) => wrapStyled(
      `${this.#palette.muted(activity.timestamp)}  ${activityStyle(activity.kind, activity.message, this.#palette)}`,
      Math.max(1, width - 2),
      (value) => value,
    )) ?? [];
    if (lines.length === 0) lines.push(this.#palette.muted("No activity recorded."));
    return panel(title, lines, width, height, this.#snapshot.focus === "activity", this.#palette, this.#snapshot.scroll.activity);
  }

  #graphPanel(width: number, height: number): string[] {
    const graph = this.#snapshot.view.selectedRun?.graph;
    const configured = cockpitView(this.#snapshot.view.cockpit, ["typed_tree", "graph"]);
    const graphOptions = configuredGraphOptions(configured);
    const lines = graph === undefined || graph.nodes.length === 0
      ? [this.#palette.muted("No graph nodes yet.")]
      : renderGraphLines(graph.nodes, graph.edges, Math.max(1, width - 2), this.#palette, graphOptions);
    const scope = configured?.source.kind === "graph" && configured.source.scope === "main_checkout"
      ? "main checkout" : graph?.scope;
    return panel(
      configured === undefined
        ? graph === undefined ? "Graph" : `Graph · ${graph.scope}`
        : scope === undefined ? configured.title : `${configured.title} · ${scope}`,
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
      return this.#renderDeleteRun(modal, width, height);
    }
    if (modal.kind === "merge") return this.#renderMergeRun(modal, width, height);
    if (modal.kind === "new_run") return this.#renderNewRun(modal, width, height);
    if (modal.kind === "plan_review") return this.#renderPlanReview(modal, width, height);
    if (modal.kind === "proposal_review") return this.#renderProposalReview(modal, width, height);
    if (modal.kind === "answer_question") return this.#renderAnswerQuestion(modal, width, height);
    if (modal.kind === "action_palette") return this.#renderActionPalette(modal, width, height);
    if (modal.kind === "action_form") return this.#renderActionForm(modal, width, height);
    if (modal.kind === "config_document_create") return this.#renderConfigDocumentCreate(modal, width, height);
    if (modal.kind === "config_document_rename") return this.#renderConfigDocumentRename(modal, width, height);
    if (modal.kind === "config_document_delete") return this.#renderConfigDocumentDelete(modal, width, height);
    if (modal.kind === "config_run_type_wizard") return this.#renderConfigRunTypeWizard(modal, width, height);
    if (modal.kind === "config_legacy_migration") return this.#renderConfigLegacyMigration(modal, width, height);
    if (modal.kind === "edit_scalar") return this.#renderEditScalar(modal, width, height);
    if (modal.kind === "configure") return this.#renderConfigure(modal, width, height);
    if (modal.kind === "configure_documents") {
      return panel(
        "Project resources",
        [this.#palette.muted("Project Resources is already open behind this surface.")],
        width,
        Math.min(height, 5),
        true,
        this.#palette,
      );
    }
    if (modal.kind === "profile_conflicts") return this.#renderProfileConflicts(modal, width, height);
    const help = HELP[modal.topic];
    return panel(
      `Help · ${help.title}`,
      [
        sectionHeading("What this is", this.#palette),
        ...wrapStyled(help.description, width - 2, this.#palette.text),
        "",
        sectionHeading("In the workflow", this.#palette),
        ...wrapStyled(helpWorkflow(modal.topic), width - 2, this.#palette.muted),
        "",
        sectionHeading("Available here", this.#palette),
        ...help.actions.map(([keys, meaning]) => `${this.#palette.accent(keys.padEnd(16))}${meaning}`),
        "",
        this.#palette.muted("[h/F1/Esc/Enter/q] close"),
      ],
      width,
      Math.min(height, Math.min(22, 13 + help.actions.length)),
      true,
      this.#palette,
    );
  }

  #renderDeleteRun(modal: DeleteRunModalState, width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const lines = [
      sectionHeading(modal.title, this.#palette),
      ...boundedWrapped(modal.objective, inner, 3, this.#palette.text),
      "",
      `${this.#palette.muted("State")} ${modal.state}   ${this.#palette.muted("Target")} ${modal.targetBranch}`,
      `${this.#palette.muted("Owned resources")} ${modal.ownedWorktrees} worktrees · ${modal.ownedBranches} branches`,
      `${this.#palette.muted("Live agents")} ${modal.liveAgents}`,
      "",
      this.#palette.error("Deletion first tombstones this run and stops every associated Pi session."),
      this.#palette.muted("Koni then retires its owned Git resources. The target branch is never deleted."),
    ];
    if (modal.blockers.length > 0) {
      lines.push("", sectionHeading("Current blockers", this.#palette));
      lines.push(...modal.blockers.flatMap((blocker) => wrapStyled(`• ${blocker}`, inner, this.#palette.warning)));
    }
    if (modal.dirtyWorktreeWarnings.length > 0) {
      lines.push("", sectionHeading("Preserved work", this.#palette));
      lines.push(...modal.dirtyWorktreeWarnings.flatMap((warning) =>
        wrapStyled(`• ${warning}`, inner, this.#palette.warning)));
    }
    lines.push(
      "",
      centerButtons([
        { label: "Cancel", selected: modal.selected === "cancel", tone: "normal" },
        {
          label: "Preserve branches",
          selected: modal.selected === "preserve_branches",
          tone: modal.canPreserveBranches ? "success" : "disabled",
        },
        {
          label: "Delete owned branches",
          selected: modal.selected === "delete_owned_branches",
          tone: modal.canDeleteOwnedBranches ? "danger" : "disabled",
        },
      ], this.#palette),
      this.#palette.dim("←→/[] choose · Enter confirm · Esc cancel · h help"),
    );
    return panel("Delete run", lines, width, height, true, this.#palette, visibleOffset(0, lines.length - 2, Math.max(1, height - 2)));
  }

  #renderMergeRun(modal: MergeRunModalState, width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const lines = [
      sectionHeading(modal.title, this.#palette),
      "",
      `${this.#palette.muted("Destination")} ${this.#palette.accent(modal.targetBranch)}`,
      `${this.#palette.muted("Prepared state")} ${modal.state}`,
      `${this.#palette.muted("Tickets")} ${modal.completedTickets}/${modal.totalTickets} complete`,
    ];
    if (modal.blockers.length > 0) {
      lines.push("", sectionHeading("Cannot promote yet", this.#palette));
      lines.push(...modal.blockers.flatMap((blocker) => wrapStyled(`• ${blocker}`, inner, this.#palette.warning)));
    } else {
      lines.push(
        "",
        this.#palette.success("Compiler preparation is complete."),
        this.#palette.muted("Authorization re-checks the target before publishing the prepared result."),
      );
    }
    if (modal.targetAdvanced || modal.resyncState !== "current") {
      lines.push(
        "",
        this.#palette.warning(modal.resyncState === "required"
          ? "The target advanced; Koni must resynchronize and verify again before promotion."
          : "The current target state is unavailable for authorization."),
      );
    }
    lines.push(
      "",
      centerButtons([
        { label: "Cancel", selected: modal.selected === "cancel", tone: "normal" },
        { label: "Authorize merge", selected: modal.selected === "authorize", tone: modal.canAuthorize ? "success" : "disabled" },
      ], this.#palette),
      this.#palette.dim("←→/[] choose · Enter authorize · Esc cancel · h help"),
    );
    return panel("Merge run", lines, width, height, true, this.#palette, visibleOffset(0, lines.length - 2, Math.max(1, height - 2)));
  }

  #renderAnswerQuestion(modal: AnswerQuestionModalState, width: number, height: number): string[] {
    const questions = this.#snapshot.view.selectedRun?.questions ?? [];
    const index = Math.max(0, questions.findIndex((question) => question.id === modal.questionId));
    const question = questions[index];
    if (question === undefined) {
      return panel(
        "Answer question",
        [this.#palette.muted("This question is no longer pending."), "", this.#palette.dim("[Esc] close")],
        width,
        Math.min(height, 7),
        true,
        this.#palette,
      );
    }
    const inner = Math.max(1, width - 2);
    const draft = this.#snapshot.questionDraft;
    const lines: string[] = [
      centerLine(`‹ ${index + 1} / ${questions.length} ›`, inner, this.#palette.muted),
      ...wrapStyled(question.prompt, inner, this.#palette.bold),
    ];
    lines.push("");
    let selectedChoiceLine = lines.length;
    for (const option of question.options) {
      const selected = draft?.selectedOptionId === option.id;
      if (selected) selectedChoiceLine = lines.length;
      const recommended = question.recommendationOptionId === option.id ? ` ${this.#palette.warning("★ Recommended")}` : "";
      const row = `${selected ? "●" : "○"} ${option.label}${recommended}`;
      lines.push(modal.focus === "choices" && selected ? this.#palette.selected(row) : row);
      lines.push(...wrapStyled(
        option.description,
        Math.max(1, inner - 4),
        (value) => `    ${this.#palette.muted(value)}`,
      ));
    }
    const none = draft?.selectedOptionId === undefined;
    if (none) selectedChoiceLine = lines.length;
    const noneRow = `${none ? "●" : "○"} None of the above`;
    lines.push(modal.focus === "choices" && none ? this.#palette.selected(noneRow) : noneRow, "");
    const notesLine = lines.length;
    lines.push(centeredDivider("Notes (optional)", inner, this.#palette));
    const notes = draft?.notes ?? "";
    const noteText = notes.length === 0 ? this.#palette.dim("Add context to any answer…") : notes;
    lines.push(...wrapStyled(
      `${modal.focus === "notes" ? "▌ " : "  "}${noteText}`,
      inner,
      (value) => modal.focus === "notes" ? this.#palette.selected(value) : value,
    ));
    const submitLine = lines.length + 1;
    const submitLabel = question.resolvesBatchOnSubmit
      ? (question.batchQuestionCount ?? 1) === 1 ? "Submit answer" : "Submit all answers"
      : question.answerSaved ? "Revise answer" : "Save & next";
    lines.push("", centeredButton(submitLabel, modal.focus === "submit", this.#palette));
    lines.push(this.#palette.dim("←→/[] question · ↑↓/jk option · Tab focus · Enter select/newline · Ctrl-Enter submit · Esc close"));
    const focusLine = modal.focus === "choices" ? selectedChoiceLine : modal.focus === "notes" ? notesLine : submitLine;
    return panel(
      "Answer question",
      lines,
      width,
      height,
      true,
      this.#palette,
      visibleOffset(0, focusLine, Math.max(1, height - 2)),
    );
  }

  #renderActionPalette(modal: ActionPaletteModalState, width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const lines: string[] = [];
    let selectedLine = 0;
    modal.actions.forEach((action, index) => {
      const selected = index === modal.selectedIndex;
      if (selected) selectedLine = lines.length;
      const available = action.availability.state === "available";
      const marker = available ? this.#palette.success("●") : this.#palette.muted("○");
      const title = `${selected ? "›" : " "} ${marker} ${action.title}`;
      lines.push(selected ? this.#palette.selected(title) : available ? title : this.#palette.muted(title));
      lines.push(...wrapStyled(
        action.description,
        Math.max(1, inner - 4),
        (value) => `    ${available ? this.#palette.text(value) : this.#palette.muted(value)}`,
      ));
      lines.push(...wrapStyled(
        action.availability.reason,
        Math.max(1, inner - 4),
        (value) => `    ${available ? this.#palette.dim(value) : this.#palette.warning(value)}`,
      ));
      if (index < modal.actions.length - 1) lines.push("");
    });
    lines.push("", this.#palette.dim("↑↓/jk choose · Enter open/run · Esc close · h help"));
    return panel(
      modal.title,
      lines,
      width,
      height,
      true,
      this.#palette,
      visibleOffset(0, selectedLine, Math.max(1, height - 2)),
    );
  }

  #renderActionForm(modal: ActionFormModalState, width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const form = modal.action.form;
    const lines: string[] = [
      ...wrapStyled(form?.description ?? modal.action.description, inner, this.#palette.muted),
      "",
    ];
    let focusLine = 0;
    (form?.fields ?? []).forEach((field, index) => {
      if (field.visibility === "hidden") return;
      const selected = modal.focus === "fields" && modal.fieldIndex === index;
      if (selected) focusLine = lines.length;
      const value = field.locked && field.displayValue !== undefined
        ? field.displayValue
        : actionValueLabel(modal.values[field.key]);
      const lock = field.locked ? ` ${this.#palette.muted("compiler bound")}` : "";
      lines.push(`${selected ? this.#palette.accent("›") : " "} ${this.#palette.bold(field.label)}  ${inputBadge(value, selected, this.#palette)}${lock}`);
      if (selected || field.locked) {
        lines.push(...wrapStyled(field.description, Math.max(1, inner - 4), (copy) => `    ${this.#palette.muted(copy)}`));
      }
      if (selected && modal.editing && !field.locked) {
        const editor = insertCaret(actionValueLabel(modal.values[field.key]), modal.cursor);
        lines.push(...wrapStyled(editor, Math.max(1, inner - 4), (copy) => `    ${this.#palette.selected(copy)}`));
      }
    });
    if (modal.action.confirmation.required) {
      const confirmation = modal.action.confirmation;
      if (modal.focus === "confirmation") focusLine = lines.length;
      lines.push(
        "",
        centeredDivider(confirmation.title, inner, this.#palette),
        ...wrapStyled(confirmation.description, inner, this.#palette.warning),
        `${modal.confirmed ? this.#palette.success("●") : this.#palette.muted("○")} ${confirmation.confirmLabel}`,
      );
    }
    if (modal.error !== undefined) lines.push("", ...wrapStyled(modal.error, inner, this.#palette.error));
    if (modal.focus === "submit") focusLine = lines.length + 1;
    lines.push(
      "",
      centeredButton(form?.submitLabel ?? modal.action.title, modal.focus === "submit", this.#palette),
      this.#palette.dim("Tab/↑↓ fields · ←→ change · Enter edit/select · Ctrl-Enter apply · Esc close · h help"),
    );
    return panel(
      form?.title ?? modal.action.title,
      lines,
      width,
      height,
      true,
      this.#palette,
      visibleOffset(0, focusLine, Math.max(1, height - 2)),
    );
  }

  #renderConfigDocumentCreate(modal: ConfigDocumentCreateModalState, width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const choice = modal.choices[modal.choiceIndex];
    const title = modal.focus === "title" ? insertCaret(modal.title, modal.cursor)
      : modal.title.length === 0 ? "Name this resource…" : modal.title;
    const lines = [
      centeredDivider("Resource type", inner, this.#palette),
      selectorWindow(modal.choices.map((item) => item.label), modal.choiceIndex, inner, this.#palette),
      ...wrapStyled(choice?.description ?? "", inner, this.#palette.muted),
      "",
      centeredDivider("Title", inner, this.#palette),
      modal.focus === "title" ? this.#palette.selected(` ${title}`) : ` ${this.#palette.muted(title)}`,
      "",
      centeredButton("Create resource", modal.focus === "submit", this.#palette),
      this.#palette.dim("←→ type/caret · Tab/↑↓ focus · Enter continue/create · Esc cancel · h help"),
    ];
    return panel("New project resource", lines, width, Math.min(height, Math.max(14, lines.length + 2)), true, this.#palette);
  }

  #renderConfigDocumentRename(modal: ConfigDocumentRenameModalState, width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const value = modal.focus === "title" ? insertCaret(modal.title, modal.cursor) : modal.title;
    return panel("Rename resource", [
      ...wrapStyled("Renaming updates semantic identity and compiler references atomically where the resource kind requires it.", inner, this.#palette.muted),
      "",
      centeredDivider("Title", inner, this.#palette),
      modal.focus === "title" ? this.#palette.selected(` ${value}`) : ` ${value}`,
      "",
      centeredButton("Rename resource", modal.focus === "submit", this.#palette),
      this.#palette.dim("←→ caret · Tab focus · Enter continue/rename · Esc cancel · h help"),
    ], width, Math.min(height, 14), true, this.#palette);
  }

  #renderConfigDocumentDelete(modal: ConfigDocumentDeleteModalState, width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const allowed = modal.canDelete;
    const explanation = allowed
      ? "The authority will compile the complete project without this resource before publishing the deletion."
      : modal.reason ?? "The configuration authority does not allow this resource to be deleted.";
    return panel("Delete project resource", [
      sectionHeading(modal.title, this.#palette),
      "",
      ...wrapStyled(
        explanation,
        inner,
        allowed ? this.#palette.warning : this.#palette.error,
      ),
      "",
      ...centerButtons([
        { label: "Cancel", selected: modal.selected === "cancel", tone: "normal" },
        { label: "Delete resource", selected: modal.selected === "delete", tone: allowed ? "danger" : "disabled" },
      ], this.#palette),
      this.#palette.dim("←→ choose · Enter confirm · Esc cancel · h help"),
    ], width, Math.min(height, 14), true, this.#palette);
  }

  #renderConfigRunTypeWizard(modal: ConfigRunTypeWizardModalState, width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const template = modal.templates.templates[modal.templateIndex];
    const field = (label: string, value: string, focus: ConfigRunTypeWizardModalState["focus"]): string[] => {
      const selected = modal.focus === focus;
      const shown = selected ? insertCaret(value, modal.cursor) : value.length === 0 ? "Optional" : value;
      return [
        `${selected ? this.#palette.accent("›") : " "} ${this.#palette.bold(label)}  ${inputBadge(shown, selected, this.#palette)}`,
      ];
    };
    const description = modal.focus === "description"
      ? insertCaret(modal.description, modal.cursor)
      : modal.description.length === 0 ? "Describe when this workflow should be used…" : modal.description;
    const lines = [
      centeredDivider("Template", inner, this.#palette),
      selectorWindow(modal.templates.templates.map((item) => item.title), modal.templateIndex, inner, this.#palette),
      ...wrapStyled(template?.description ?? "", inner, this.#palette.muted),
      "",
      ...field("Title", modal.title, "title"),
      ...field("Slug", modal.slug, "slug"),
      `${modal.focus === "description" ? this.#palette.accent("›") : " "} ${this.#palette.bold("Description")}`,
      ...wrapStyled(description, Math.max(1, inner - 3), (copy) => `   ${modal.focus === "description" ? this.#palette.selected(copy) : this.#palette.muted(copy)}`),
      `${modal.makeDefault ? this.#palette.success("●") : this.#palette.muted("○")} Make this the project default`,
      "",
      centeredButton("Create run type", modal.focus === "submit", this.#palette),
      this.#palette.dim("Tab/↑↓ focus · ←→ change · Enter continue/newline · Ctrl-Enter create · Esc cancel"),
    ];
    return panel("New run type", lines, width, height, true, this.#palette, visibleOffset(0, lines.length - 2, Math.max(1, height - 2)));
  }

  #renderConfigLegacyMigration(modal: ConfigLegacyMigrationModalState, width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const preview = modal.preview;
    const lines = [
      sectionHeading("Legacy project detected", this.#palette),
      ...wrapStyled(
        `Koni can import this ${titleCaseLabel(preview.sourceKind)} configuration into the managed ${preview.profileVersion} profile model.`,
        inner,
        this.#palette.text,
      ),
      "",
      `${this.#palette.muted("Configuration files")} ${preview.configurationFiles}`,
      `${this.#palette.muted("External agents")} ${preview.externalAgents}`,
      `${this.#palette.muted("Historical runs")} ${preview.runs}`,
      `${this.#palette.muted("Run barrier")} ${preview.requiresRunBarrier ? this.#palette.warning("required") : "not required"}`,
      "",
      this.#palette.success("The original legacy source will be retained."),
      ...wrapStyled("Applying revalidates the exact preview token, project state, run barrier, and target profile before publication.", inner, this.#palette.muted),
      "",
      ...centerButtons([
        { label: "Cancel", selected: modal.selected === "cancel", tone: "normal" },
        { label: "Apply migration", selected: modal.selected === "apply", tone: "success" },
      ], this.#palette),
      this.#palette.dim("←→ choose · Enter apply · Esc cancel · h help"),
    ];
    return panel("Legacy migration", lines, width, Math.min(height, Math.max(16, lines.length + 2)), true, this.#palette);
  }

  #renderEditScalar(modal: EditScalarModalState, width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const withCaret = insertCaret(modal.value, modal.cursor);
    const editor = withCaret.split("\n").flatMap((line) => wrapStyled(
      line.length === 0 ? " " : line,
      inner,
      this.#palette.selected,
    ));
    const valueRows = Math.max(2, height - 10 - Number(modal.error !== undefined));
    const caretLine = Math.max(0, editor.findIndex((line) => line.includes("▌")));
    const start = visibleOffset(0, caretLine, valueRows);
    const visible = editor.slice(start, start + valueRows);
    while (visible.length < valueRows) visible.push(this.#palette.selected(" "));
    const submit = modal.field.kind === "multiline" || modal.field.kind === "string_list"
      ? "Ctrl-Enter apply"
      : "Enter apply";
    return panel(`Edit ${modal.field.label}`, [
      ...wrapStyled(modal.field.description, inner, this.#palette.muted),
      `${this.#palette.muted("Type")} ${configKindLabel(modal.field.kind)}`,
      "",
      ...visible,
      ...(modal.error === undefined ? [] : ["", ...wrapStyled(modal.error, inner, this.#palette.error)]),
      "",
      this.#palette.dim(`←→ caret · Home/End · Backspace/Delete · ${submit} · Esc cancel · h help`),
    ], width, height, true, this.#palette);
  }

  #newRunTargetLines(modal: NewRunModalState): string[] {
    const lines = [
      selectorLine("Target branch", runTargetSelectedLabel(modal.target), modal.focus === "branch", this.#palette),
    ];
    if (isCreatingNewTarget(modal.target)) {
      const name = modal.target.newName;
      lines.push(selectorLine(
        "New branch name",
        name.length === 0 ? "(type a name)" : name,
        modal.focus === "branch_name",
        this.#palette,
      ));
    }
    return lines;
  }

  #renderNewRun(modal: NewRunModalState, width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const runType = this.#snapshot.runTypes.find((item) => item.id === modal.runTypeId);
    const objectiveRows = height >= 30 ? 3 : 1;
    const objectiveSource = modal.focus === "objective"
      ? insertCaret(modal.objective, modal.objectiveCursor)
      : modal.objective.length === 0 ? "Describe the outcome…" : modal.objective;
    const objectiveLines = wrapTextWithAnsi(objectiveSource, inner - 2);
    const objectiveCaretLine = Math.max(0, objectiveLines.findIndex((line) => line.includes("▌")));
    const objectiveStart = modal.focus === "objective"
      ? Math.max(0, objectiveCaretLine - objectiveRows + 1)
      : Math.max(0, objectiveLines.length - objectiveRows);
    const objectiveVisible = objectiveLines.slice(objectiveStart, objectiveStart + objectiveRows);
    const intakeLines = runType === undefined ? [] : newRunAdditionalIntakeLines(modal, runType, inner, this.#palette);
    const runTypeBadges = this.#snapshot.runTypes.map((item) => runTypeBadge(item.title, item.id === modal.runTypeId, this.#palette));
    const runTypeLines = wrapSegments(runTypeBadges, inner);
    const fixedRows = 15 + objectiveVisible.length + intakeLines.length + modal.roles.length + runTypeLines.length;
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
        ...intakeLines,
        centeredDivider("Run Config", inner, this.#palette),
        selectorWindow(this.#snapshot.runTypes.map((item) => item.title), Math.max(0, this.#snapshot.runTypes.findIndex((item) => item.id === modal.runTypeId)), inner, this.#palette),
        ...this.#newRunTargetLines(modal),
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
      ...intakeLines,
      centeredDivider("Run Config", inner, this.#palette),
      ...runTypeLines,
      ...this.#newRunTargetLines(modal),
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
    const selectedRun = this.#snapshot.view.selectedRun;
    const approval = selectedRun?.approval;
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
    const steeringSource = modal.focus === "steering"
      ? insertCaret(modal.steering, modal.steeringCursor)
      : modal.steering.length === 0 ? "Add steering here to request a revised plan…" : modal.steering;
    const steeringLines = wrapTextWithAnsi(steeringSource, inner - 2);
    const editorRows = Math.max(2, Math.min(4, Math.floor(height / 5)));
    const bodyRows = Math.max(2, height - editorRows - 11);
    const bodyStart = Math.min(modal.scroll, Math.max(0, document.length - bodyRows));
    const visibleDocument = document.slice(bodyStart, bodyStart + bodyRows);
    while (visibleDocument.length < bodyRows) visibleDocument.push("");
    const steeringCaretLine = Math.max(0, steeringLines.findIndex((line) => line.includes("▌")));
    const steeringStart = modal.focus === "steering"
      ? Math.max(0, steeringCaretLine - editorRows + 1)
      : Math.max(0, steeringLines.length - editorRows);
    const steeringVisible = steeringLines.slice(steeringStart, steeringStart + editorRows);
    while (steeringVisible.length < editorRows) steeringVisible.push("");
    const hasSteering = modal.steering.trim().length > 0;
    const button = hasSteering ? "Revise plan" : "Approve run";
    const lines = [
      `${this.#palette.muted("Objective")} ${truncateToWidth(selectedRun?.objective.text ?? "Selected run", Math.max(1, inner - 10), "…")}`,
      `${this.#palette.muted("Run type")} ${selectedRun?.header.runType ?? "Unknown"}`,
      "",
      tabs,
      ...visibleDocument,
      centeredDivider("Steering instructions", inner, this.#palette),
      ...steeringVisible.map((line) => ` ${modal.steering.length === 0 && modal.focus !== "steering" ? this.#palette.dim(line) : line}`),
      centeredButton(button, modal.focus === "action", this.#palette),
      this.#palette.dim("←→/[] sections · ↑↓/jk/PgUp/PgDn scroll · Tab focus · Enter · Esc"),
    ];
    return panel("Review plan", lines, width, height, true, this.#palette);
  }

  #renderProposalReview(modal: ProposalReviewModalState, width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const proposal = modal.proposal;
    const document: string[] = [
      sectionHeading(proposal.title, this.#palette),
      ...wrapStyled(proposal.summary, inner, this.#palette.text),
      "",
      `${this.#palette.muted("Status")} ${this.#palette.warning("Awaiting your decision")}`,
      `${this.#palette.muted("Scope")} ${proposal.targetNodeIds.length} graph ${proposal.targetNodeIds.length === 1 ? "node" : "nodes"}`,
      `${this.#palette.muted("Proposed")} ${formatOperatorTimestamp(proposal.createdAt)}`,
      "",
      ...wrapStyled(
        "Approval authorizes the compiler-defined proposal workflow. Rejection closes this proposal without applying it.",
        inner,
        this.#palette.muted,
      ),
    ];
    const editorRows = Math.max(2, Math.min(5, Math.floor(height / 5)));
    const fixedRows = editorRows + 10;
    const documentRows = Math.max(3, height - fixedRows);
    const documentStart = Math.min(modal.scroll, Math.max(0, document.length - documentRows));
    const visibleDocument = document.slice(documentStart, documentStart + documentRows);
    while (visibleDocument.length < documentRows) visibleDocument.push("");

    const messageSource = modal.focus === "message"
      ? insertCaret(modal.message, modal.messageCursor)
      : modal.message.length === 0 ? "Optional context for this decision…" : modal.message;
    const messageLines = wrapTextWithAnsi(messageSource, Math.max(1, inner - 2));
    const caretLine = Math.max(0, messageLines.findIndex((line) => line.includes("▌")));
    const messageStart = modal.focus === "message"
      ? Math.max(0, caretLine - editorRows + 1)
      : Math.max(0, messageLines.length - editorRows);
    const visibleMessage = messageLines.slice(messageStart, messageStart + editorRows);
    while (visibleMessage.length < editorRows) visibleMessage.push("");

    const lines = [
      ...visibleDocument,
      centeredDivider("Decision message (optional)", inner, this.#palette),
      ...visibleMessage.map((line) => ` ${modal.message.length === 0 && modal.focus !== "message" ? this.#palette.dim(line) : line}`),
      centerButtons([
        { label: "Approve proposal", selected: modal.focus === "choice" && modal.decision === "approval", tone: "success" },
        { label: "Reject proposal", selected: modal.focus === "choice" && modal.decision === "rejection", tone: "danger" },
      ], this.#palette),
      centeredButton(
        modal.decision === "approval" ? "Record approval" : modal.decision === "rejection" ? "Record rejection" : "Choose a decision",
        modal.focus === "submit",
        this.#palette,
      ),
      this.#palette.dim("↑↓ scroll · Tab focus · ←→ choose · Enter navigate/newline · Ctrl-Enter record · Esc close"),
    ];
    return panel("Review change proposal", lines, width, height, true, this.#palette);
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
    const hasUpstream = modal.upstreamConflicts.conflicts.length > 0;
    const contentHeight = Math.max(5, height - 8 - Number(modal.rebaseRequired) - Number(hasUpstream));
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
      ...(hasUpstream ? [this.#palette.warning(
        `${modal.upstreamConflicts.conflicts.length} upstream ${modal.upstreamConflicts.conflicts.length === 1 ? "change needs" : "changes need"} review · [u] Open comparison`,
      )] : []),
      ...(modal.rebaseRequired ? [this.#palette.warning("Saved draft is stale · Ctrl-R rebase or Ctrl-D discard")] : []),
      ...joined,
      actionRow,
      centeredButton(publish, modal.focus === "publish", this.#palette),
      this.#palette.dim("←→ sections/values/actions · ↑↓ resources/fields · Tab focus · Enter select · u upstream changes · a add · d duplicate · x delete · Ctrl-S save · Ctrl-R rebase · Ctrl-P publish · Ctrl-D discard · Esc close · h help"),
    ], width, height, true, this.#palette);
  }

  #renderProfileConflicts(modal: ProfileConflictsModalState, width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const selected = modal.catalog.conflicts[modal.selectedIndex] ?? modal.inspection.conflict;
    const labels = modal.catalog.conflicts.map((conflict) =>
      `${conflict.title} · ${conflict.reason}`);
    const selector = selectorWindow(labels, modal.selectedIndex, inner, this.#palette);
    const columnGap = 1;
    const leftWidth = Math.max(1, Math.floor((inner - columnGap) / 2));
    const rightWidth = Math.max(1, inner - columnGap - leftWidth);
    const bodyHeight = Math.max(3, height - 10);
    const current = conflictDocumentLines(
      modal.inspection.currentText,
      "Deleted in project",
      leftWidth,
      this.#palette,
    );
    const upstream = conflictDocumentLines(
      modal.inspection.upstreamText,
      "Removed upstream",
      rightWidth,
      this.#palette,
    );
    const maxScroll = Math.max(0, Math.max(current.length, upstream.length) - bodyHeight);
    const start = Math.min(modal.scroll, maxScroll);
    const comparison = joinColumns([
      current.slice(start, start + bodyHeight),
      upstream.slice(start, start + bodyHeight),
    ], [leftWidth, rightWidth], bodyHeight);
    const actions = ["Keep project", "Use update"];
    const actionRow = actions.map((label, index) => selectorBadge(
      label,
      modal.focus === "actions" && modal.actionIndex === index,
      this.#palette,
    )).join("  ");
    return panel("Upstream changes", [
      selector,
      `${modal.focus === "list" ? this.#palette.accent("›") : " "} ${this.#palette.bold(selected.title)} ${this.#palette.muted(`· ${conflictReason(selected.reason)} · ${selected.domain}`)}`,
      this.#palette.dim(selected.path),
      joinColumns([
        [sectionHeading("Project version", this.#palette)],
        [sectionHeading("Upstream update", this.#palette)],
      ], [leftWidth, rightWidth], 1)[0]!,
      ...comparison,
      actionRow,
      this.#palette.dim("↑↓/jk change resource · PgUp/PgDn scroll · Tab actions · ←→ choose · Enter resolve · Esc back · h help"),
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

  #animatedCog(): string {
    const styles = [this.#palette.accent, this.#palette.info, this.#palette.success, this.#palette.info] as const;
    return styles[this.#animationFrame]!("⚙");
  }
}

function helpWorkflow(topic: ControlCenterHelpTopic): string {
  if (topic === "runs" || topic === "new_run") return "Runs are the durable top-level units Koni plans, schedules, verifies, and prepares for an operator-authorized merge.";
  if (topic === "tickets" || topic === "agents" || topic === "chat") return "The compiler turns the run specification into tickets; exact agent attempts carry out bounded ticket steps and preserve their Pi sessions.";
  if (topic === "questions" || topic === "answer_question") return "Questions stop ambiguous work at a durable decision boundary. Your answer is recorded before the responsible work can continue.";
  if (topic === "action_palette" || topic === "action_form") return "The compiler projects exactly which run and stage actions exist now. Koni revalidates the opaque action, run revision, generation, fields, and confirmation before any effect.";
  if (topic === "plan_review") return "Planning turns the goal into architecture, decisions, risk controls, verification, and an initial graph. Work starts only after explicit approval.";
  if (topic === "proposal_review") return "Change proposals hold overlapping compiler work at a durable operator boundary. Inspection is read-only; only an explicit recorded approval or rejection advances authority state.";
  if (topic === "configure" || topic === "configure_documents" ||
      topic === "config_document_create" || topic === "config_document_rename" ||
      topic === "config_document_delete" || topic === "config_run_type_wizard" ||
      topic === "config_legacy_migration" || topic === "profile_conflicts" ||
      topic === "edit_scalar") return "Configuration compiles project-owned profiles into the graph vocabulary, workflows, tickets, resources, models, and lifecycle rules used by future runs.";
  if (topic === "graph") return "The graph is the shared typed specification from which the compiler validates relationships and derives ready work.";
  if (topic === "activity") return "Activity is the human audit trail across compiler decisions, graph changes, agent work, Git, and lifecycle transitions.";
  return "This panel is one view of the same durable run state used by scheduling, verification, recovery, and final promotion.";
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
  const body = content.slice(start, start + capacity).map((line) => {
    const clipped = truncateToWidth(line, innerWidth, "…", true);
    return `${border("│")}${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}${border("│")}`;
  });
  while (body.length < capacity) body.push(`${border("│")}${" ".repeat(innerWidth)}${border("│")}`);
  return [padLine(top, safeWidth), ...body, border(`└${"─".repeat(innerWidth)}┘`)];
}

function panelWithFooter(
  title: string,
  content: readonly string[],
  footer: string,
  width: number,
  height: number,
  focused: boolean,
  palette: KoniPalette,
  scroll = 0,
): string[] {
  const safeHeight = Math.max(4, height);
  const capacity = Math.max(1, safeHeight - 3);
  const start = Math.min(Math.max(0, scroll), Math.max(0, content.length - capacity));
  const lines = panel(title, content.slice(start, start + capacity), width, safeHeight, focused, palette);
  const safeWidth = Math.max(4, width);
  const inner = safeWidth - 2;
  const border = focused ? palette.borderActive : palette.border;
  const clipped = truncateToWidth(centerLine(footer, inner, palette.accent), inner, "…", true);
  lines[safeHeight - 2] = `${border("│")}${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}${border("│")}`;
  return lines;
}

function framedHeader(title: string, metadata: string, width: number, palette: KoniPalette): string[] {
  const inner = Math.max(1, width - 2);
  return [
    palette.border(`┌${"─".repeat(inner)}┐`),
    framedLine(` ${title}`, inner, palette),
    framedLine(` ${metadata}`, inner, palette),
    palette.border(`└${"─".repeat(inner)}┘`),
  ].map((line) => padLine(line, width));
}

function detailsTitle(
  snapshot: ControlCenterControllerSnapshot,
  palette: KoniPalette,
  configuredTitle?: string,
): string {
  if (snapshot.selection.detailsTab === "chat") {
    const agent = snapshot.view.selectedRun?.agents.find((candidate) => candidate.id === snapshot.selection.attemptId);
    return agent === undefined ? "Chat" : `${agent.active ? "⚙ " : ""}Chat · ${agent.label}`;
  }
  const active = snapshot.selection.detailsTab;
  const label = (id: "overview" | "plan" | "stages", title: string): string =>
    id === active ? palette.text(title) : palette.muted(title);
  const tabs = [label("overview", "Overview"), label("plan", "Plan"), label("stages", "Stages")];
  return `${palette.muted(`${configuredTitle ?? "Details"}:`)} ${tabs.join(palette.muted(" - "))}`;
}

function joinColumns(columns: readonly string[][], widths: readonly number[], height: number): string[] {
  return Array.from({ length: height }, (_, row) => columns.map((column, index) =>
    padLine(column[row] ?? "", widths[index]!),
  ).join(""));
}

function resizeScreen(width: number, height: number, palette: KoniPalette): string[] {
  const inner = Math.max(0, width - 2);
  const capacity = Math.max(0, height - 2);
  const copy = [
    `Koni Control Center needs at least ${CONTROL_CENTER_MIN_WIDTH}×${CONTROL_CENTER_MIN_HEIGHT}`,
    `current terminal: ${width}×${height}`,
  ];
  const body = Array.from({ length: capacity }, () => " ".repeat(inner));
  const start = Math.max(0, Math.floor((capacity - copy.length) / 2));
  copy.forEach((line, index) => {
    const clipped = truncateToWidth(line, inner, "…");
    const left = Math.max(0, Math.floor((inner - visibleWidth(clipped)) / 2));
    body[start + index] = `${" ".repeat(left)}${clipped}${" ".repeat(Math.max(0, inner - left - visibleWidth(clipped)))}`;
  });
  if (height === 1) return [truncateToWidth("resize terminal", width, "")];
  const title = truncateToWidth(" resize terminal ", inner, "");
  const top = `${palette.border("┌")} ${title}${palette.border(`${"─".repeat(Math.max(0, inner - visibleWidth(title) - 1))}┐`)}`;
  const rows = [padLine(top, width)];
  rows.push(...body.map((line) => `${palette.border("│")}${line}${palette.border("│")}`));
  if (rows.length < height) rows.push(palette.border(`└${"─".repeat(inner)}┘`));
  return fitRows(rows, width, height);
}

function fitRows(lines: readonly string[], width: number, rows: number): string[] {
  const output = lines.slice(0, rows).map((line) => padLine(line, width));
  while (output.length < rows) output.push(" ".repeat(width));
  return output;
}

function padLine(line: string, width: number): string {
  const clipped = truncateToWidth(line, width, "", true);
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function framedLine(value: string, width: number, palette: KoniPalette): string {
  const clipped = truncateToWidth(value, width, "…", true);
  return `${palette.border("│")}${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}${palette.border("│")}`;
}

function wrapStyled(value: string, width: number, style: (line: string) => string): string[] {
  return wrapTextWithAnsi(value, Math.max(1, width)).map(style);
}

function centerLine(value: string, width: number, style: (value: string) => string): string {
  const clipped = truncateToWidth(value, width, "…");
  const left = Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2));
  return `${" ".repeat(left)}${style(clipped)}`;
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

function centerButtons(
  buttons: readonly { label: string; selected: boolean; tone: "normal" | "success" | "danger" | "disabled" }[],
  palette: KoniPalette,
): string {
  const rendered = buttons.map((button) => {
    const body = `  ${button.label}  `;
    const toned = button.tone === "danger" ? palette.error(body)
      : button.tone === "success" ? palette.success(body)
        : button.tone === "disabled" ? palette.dim(body)
          : palette.text(body);
    return button.selected ? palette.selected(toned) : palette.border(`[${toned}]`);
  }).join("  ");
  return `${" ".repeat(Math.max(0, 20 - Math.floor(visibleWidth(rendered) / 2)))}${rendered}`;
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

function newRunAdditionalIntakeLines(
  modal: NewRunModalState,
  runType: ControlRunTypeOption,
  width: number,
  palette: KoniPalette,
): string[] {
  const lines: string[] = [];
  for (const field of runType.intake.filter((candidate) => candidate.id !== runType.objectiveFieldId)) {
    const focused = modal.focus === `intake:${field.id}`;
    lines.push("", palette.muted(`${field.label}${field.required ? " *" : ""}`));
    if (field.description.length > 0) lines.push(...wrapStyled(field.description, width, palette.dim));
    lines.push(...controlIntakeValueLines(modal, field, width, palette, focused));
  }
  return lines;
}

function controlIntakeValueLines(
  modal: NewRunModalState,
  field: ControlIntakeField,
  width: number,
  palette: KoniPalette,
  focused: boolean,
): string[] {
  if (field.kind === "boolean") {
    const current = modal.intake[field.id] === true;
    return [[false, true].map((value) => selectorBadge(value ? "yes" : "no", current === value || focused && current === value, palette)).join("  ")];
  }
  if (field.kind === "choice" || field.kind === "multi_choice") {
    const selected = field.kind === "choice"
      ? new Set(typeof modal.intake[field.id] === "string" ? [modal.intake[field.id] as string] : [])
      : new Set(Array.isArray(modal.intake[field.id]) ? (modal.intake[field.id] as readonly unknown[]).filter((item): item is string => typeof item === "string") : []);
    const index = modal.intakeOptionIndexes[field.id] ?? 0;
    const result: string[] = [];
    field.options.forEach((option, optionIndex) => {
      const label = `${field.kind === "multi_choice" ? selected.has(option.value) ? "✓ " : "□ " : ""}${option.label}`;
      result.push(selectorBadge(label, selected.has(option.value) || focused && index === optionIndex, palette));
      if (option.description !== undefined) result.push(...wrapStyled(option.description, Math.max(1, width - 2), palette.dim).map((line) => `  ${line}`));
    });
    if (field.kind === "multi_choice") result.push(palette.dim("←/→ choose · Enter toggles"));
    return result;
  }
  const source = modal.intakeText[field.id] ?? "";
  const cursor = modal.intakeCursors[field.id] ?? 0;
  const display = focused
    ? `${Array.from(source).slice(0, cursor).join("")}▌${Array.from(source).slice(cursor).join("")}`
    : source.length === 0 ? "Enter a value…" : source;
  const wrapped = wrapTextWithAnsi(display, Math.max(1, width - 1));
  const limit = field.kind === "text" || field.kind === "json" ? 8 : 2;
  return wrapped.slice(0, limit).map((line) => focused ? palette.selected(` ${line}`) : source.length === 0 ? palette.dim(` ${line}`) : ` ${line}`);
}

function questionBadge(value: string, selected: boolean, palette: KoniPalette): string {
  const label = value === "none" ? "no" : value;
  const color = (text: string): string => value === "none" ? palette.muted(text)
    : value === "some" ? palette.info(text) : palette.warning(text);
  const badge = color(` ${label} `);
  return selected ? palette.selected(badge) : palette.border(`[${badge}]`);
}

function configDomainGlyph(id: string): string {
  const normalized = id.toLocaleLowerCase("en-US");
  if (normalized.includes("run")) return "▶";
  if (normalized.includes("agent")) return "●";
  if (normalized.includes("skill")) return "✦";
  if (normalized.includes("workflow") || normalized.includes("ticket")) return "↳";
  if (normalized.includes("graph") || normalized.includes("rule")) return "◇";
  if (normalized.includes("action") || normalized.includes("check")) return "✓";
  if (normalized.includes("report") || normalized.includes("view")) return "▤";
  if (normalized.includes("advanced")) return "⚙";
  return "◆";
}

function configDocumentDomainGlyph(id: string): string {
  return configDomainGlyph(id);
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(value < 10 * 1_024 ? 1 : 0)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
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

function recentActivityTitle(duration: string | undefined, width: number, configuredTitle = "Recent Activity"): string {
  if (duration === undefined) return configuredTitle;
  const full = `${configuredTitle} · ${duration} active`;
  if (visibleWidth(full) <= width) return full;
  const identity = configuredTitle === "Recent Activity" ? "Activity" : configuredTitle;
  const compact = `${identity} · ${duration.replace(/\s+/gu, "")}`;
  if (visibleWidth(compact) <= width) return compact;
  return visibleWidth(identity) <= width ? identity : truncateToWidth(identity, width, "…");
}

/** Select only complete control-copy groups; never leave a clipped half-label at a panel edge. */
function completeFooter(candidates: readonly string[], width: number): string {
  return candidates.find((candidate) => visibleWidth(candidate) <= width) ?? "";
}

function formatOperatorTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Compact operator-facing age ("34m", "3h", "2d") for run rows; falls back to the raw value. */
function relativeAge(createdAt: string): string {
  const parsed = Date.parse(createdAt);
  if (Number.isNaN(parsed)) return createdAt;
  const elapsedMs = Math.max(0, Date.now() - parsed);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function footerHelp(width: number): string {
  const candidates = [
    "[n] new  [a] actions  [c] configure  [v] review  [Tab] panels  [↑↓/jk] move  [←→/[]] tabs  [Space] pause  [m] merge  [d] delete  [h] help  [q] close",
    "[n] new  [a] actions  [c] config  [v] review  [Tab] panels  [↑↓/jk] move  [Space] pause  [h] help  [q] close",
    "[n] new  [a] actions  [c] config  [Tab] panels  [↑↓] move  [h] help  [q] close",
  ];
  return candidates.find((candidate) => visibleWidth(candidate) <= width) ?? "[n] new  [a] actions  [c] config  [h] help  [q] close";
}

function modalEditingText(snapshot: ControlCenterControllerSnapshot): boolean {
  const modal = snapshot.modal;
  return modal?.kind === "new_run" && modal.focus === "objective"
    || modal?.kind === "plan_review" && modal.focus === "steering"
    || modal?.kind === "proposal_review" && modal.focus === "message"
    || modal?.kind === "edit_scalar"
    || modal?.kind === "action_form" && modal.editing
    || modal?.kind === "configure" && (modal.editing || modal.resourceOperation?.focus === "name")
    || modal?.kind === "configure_documents" && modal.editing
    || modal?.kind === "config_document_create" && modal.focus === "title"
    || modal?.kind === "config_document_rename" && modal.focus === "title"
    || modal?.kind === "config_run_type_wizard" &&
      (modal.focus === "title" || modal.focus === "slug" || modal.focus === "description");
}

function insertCaret(value: string, offset: number): string {
  const characters = Array.from(value);
  characters.splice(Math.max(0, Math.min(characters.length, offset)), 0, "▌");
  return characters.join("");
}

function configKindLabel(kind: ConfigFieldDefinition["kind"]): string {
  if (kind === "string_list") return "list · one item per line";
  if (kind === "multiline") return "multiline text";
  if (kind === "integer") return "whole number";
  return kind.replace(/_/gu, " ");
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

function actionValueLabel(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? "Empty" : value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.length === 0 ? "Empty" : value;
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

function conflictDocumentLines(
  source: string | null,
  absentLabel: string,
  width: number,
  palette: KoniPalette,
): string[] {
  if (source === null) return [palette.muted(`(${absentLabel})`)];
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const rendered = lines.flatMap((line) => wrapStyled(
    line.length === 0 ? " " : line,
    width,
    palette.text,
  ));
  return rendered.length === 0 ? [palette.muted("(empty document)")] : rendered;
}

function conflictReason(reason: "modified" | "deleted" | "orphaned"): string {
  if (reason === "modified") return "both project and upstream changed";
  if (reason === "deleted") return "project deleted a file updated upstream";
  return "upstream removed a project-owned file";
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

function hasAnimatedWork(snapshot: ControlCenterControllerSnapshot): boolean {
  return snapshot.view.runs.some((run) => run.provisional || run.activeAgentCount > 0);
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

interface GraphDisplayEdge {
  source: string;
  target: string;
  relation: string;
}

export interface GraphRenderOptions {
  hierarchy?: readonly string[];
  primaryParentPreferences?: Readonly<Record<string, readonly string[]>>;
  reverseDisplayEdges?: Readonly<Record<string, string>>;
  showTitles?: boolean;
}

function configuredGraphOptions(view: CompiledCockpitView | undefined): GraphRenderOptions {
  const hierarchy = cockpitStringArrayOption(view, "hierarchy");
  const primaryParentPreferences = cockpitStringArrayMapOption(view, "primary_parent_preferences");
  const reverseDisplayEdges = cockpitStringMapOption(view, "reverse_display_edges");
  return {
    ...(hierarchy === undefined ? {} : { hierarchy }),
    ...(primaryParentPreferences === undefined ? {} : { primaryParentPreferences }),
    ...(reverseDisplayEdges === undefined ? {} : { reverseDisplayEdges }),
    showTitles: cockpitBooleanOption(view, "show_titles", true),
  };
}

interface NestedGraphRow {
  node: GraphNodeView;
  structural: string;
  prefix: string;
  isRoot: boolean;
  isLast: boolean;
  markerStart: number;
  markerEnd: number;
  titleStart: number;
}

interface ExpandedGraphRow {
  structural: string;
  nodeRow?: NestedGraphRow;
}

/**
 * Autoresearch-v2 relationship outline with Koni's one deliberate addition: concise titles are
 * painted after every connector, so title letters replace a line cell while topology continues
 * underneath. Primary relationships form the nested outline; secondary relationships get their
 * own labeled endpoint rows and shared vertical lanes.
 */
export function renderGraphLines(
  nodes: readonly GraphNodeView[],
  edges: readonly { source: string; target: string; relation?: string }[],
  width: number,
  palette: KoniPalette,
  options: GraphRenderOptions = {},
): string[] {
  if (nodes.length === 0 || width < 3) return [];
  const compareNodes = (left: GraphNodeView, right: GraphNodeView): number =>
    graphNodeCompare(left, right, options.hierarchy);
  const ordered = [...nodes].sort(compareNodes);
  const byId = new Map(ordered.map((node) => [node.id, node]));
  const normalized = normalizeGraphEdges(edges, byId, options.reverseDisplayEdges, compareNodes);
  const primaryByChild = choosePrimaryGraphEdges(normalized, byId, compareNodes, options.primaryParentPreferences);
  const primaryKeys = new Set([...primaryByChild.values()].map(graphEdgeKey));
  const secondary = normalized.filter((edge) => !primaryKeys.has(graphEdgeKey(edge)));
  const children = new Map<string, GraphDisplayEdge[]>();
  for (const edge of primaryByChild.values()) {
    const list = children.get(edge.source) ?? [];
    list.push(edge);
    children.set(edge.source, list);
  }
  for (const list of children.values()) {
    list.sort((left, right) => compareNodes(byId.get(left.target)!, byId.get(right.target)!) || left.relation.localeCompare(right.relation));
  }

  const rows: NestedGraphRow[] = [];
  const emitted = new Set<string>();
  const append = (
    node: GraphNodeView,
    rawPrefix: string,
    isLast: boolean,
    isRoot: boolean,
    incoming?: GraphDisplayEdge,
  ): void => {
    if (emitted.has(node.id)) return;
    emitted.add(node.id);
    const prefix = compactGraphPrefix(rawPrefix, width);
    const branch = isRoot ? "" : isLast ? "└─" : "├─";
    const edgeBranch = isRoot ? "" : `${branch}<${formatGraphRelation(incoming?.relation ?? "related")}>─`;
    const badge = graphBadge(node.type, width);
    const structural = `${prefix}${edgeBranch}${badge}`;
    const markerStart = visibleWidth(`${prefix}${edgeBranch}`);
    const markerEnd = markerStart + visibleWidth(badge);
    rows.push({ node, structural, prefix, isRoot, isLast, markerStart, markerEnd, titleStart: markerEnd + 1 });
    const outgoing = children.get(node.id) ?? [];
    const childPrefix = isRoot ? "" : `${prefix}${isLast ? "   " : "│  "}`;
    outgoing.forEach((edge, index) => {
      const child = byId.get(edge.target);
      if (child !== undefined) append(child, childPrefix, index + 1 === outgoing.length, false, edge);
    });
  };

  const roots = ordered.filter((node) => !primaryByChild.has(node.id));
  const rootList = roots.length === 0 ? ordered.slice(0, 1) : roots;
  rootList.forEach((node, index) => append(node, "", index + 1 === rootList.length, true));
  for (const node of ordered) append(node, "", true, true);

  const rowByNode = new Map(rows.map((row, index) => [row.node.id, index]));
  const endpoints = new Map<number, { edgeIndex: number; source: boolean }[]>();
  secondary.forEach((edge, edgeIndex) => {
    const source = rowByNode.get(edge.source);
    const target = rowByNode.get(edge.target);
    if (source === undefined || target === undefined || source === target) return;
    const sourceList = endpoints.get(source) ?? [];
    sourceList.push({ edgeIndex, source: true });
    endpoints.set(source, sourceList);
    const targetList = endpoints.get(target) ?? [];
    targetList.push({ edgeIndex, source: false });
    endpoints.set(target, targetList);
  });

  const expanded: ExpandedGraphRow[] = [];
  const endpointRows = new Map<string, number>();
  const endpointStarts = new Map<string, number>();
  rows.forEach((row, rowIndex) => {
    expanded.push({ structural: row.structural, nodeRow: row });
    const rowEndpoints = (endpoints.get(rowIndex) ?? []).sort((left, right) => left.edgeIndex - right.edgeIndex || Number(right.source) - Number(left.source));
    for (const endpoint of rowEndpoints) {
      const edge = secondary[endpoint.edgeIndex]!;
      const childPrefix = row.isRoot ? "" : `${row.prefix}${row.isLast ? "   " : "│  "}`;
      const local = endpoint.source ? `├─<${formatGraphRelation(edge.relation)}>─` : "├────";
      const structural = `${childPrefix}${local}`;
      const key = `${endpoint.edgeIndex}:${endpoint.source ? "source" : "target"}`;
      endpointRows.set(key, expanded.length);
      endpointStarts.set(key, Math.max(0, visibleWidth(structural) - 1));
      expanded.push({ structural });
    }
  });

  const canvas = Array.from({ length: Math.max(1, expanded.length) }, () => Array.from({ length: width }, () => " "));
  const usedLanes: number[] = [];
  secondary.forEach((edge, edgeIndex) => {
    const sourceY = endpointRows.get(`${edgeIndex}:source`);
    const targetY = endpointRows.get(`${edgeIndex}:target`);
    if (sourceY === undefined || targetY === undefined) return;
    const sourceStart = endpointStarts.get(`${edgeIndex}:source`) ?? 0;
    const targetStart = endpointStarts.get(`${edgeIndex}:target`) ?? 0;
    const sourceNodeRow = rows[rowByNode.get(edge.source)!]!;
    const targetNodeRow = rows[rowByNode.get(edge.target)!]!;
    const base = Math.min(width - 1, Math.max(sourceStart, targetStart, visibleWidth(sourceNodeRow.structural), visibleWidth(targetNodeRow.structural)) + 2);
    let lane = base;
    while (lane < width - 1 && usedLanes.some((candidate) => Math.abs(candidate - lane) < 2)) lane += 1;
    usedLanes.push(lane);
    drawGraphHorizontal(canvas, sourceY, sourceStart, lane);
    drawGraphHorizontal(canvas, targetY, targetStart, lane);
    drawGraphVertical(canvas, lane, sourceY, targetY);
  });

  expanded.forEach((row, y) => writeGraphText(canvas[y]!, 0, row.structural));
  expanded.forEach((row, y) => {
    if (row.nodeRow === undefined) return;
    if (options.showTitles !== false) {
      const available = Math.max(0, width - row.nodeRow.titleStart);
      writeGraphText(canvas[y]!, row.nodeRow.titleStart, truncateToWidth(row.nodeRow.node.label, available, "…"));
    }
  });

  return canvas.map((cells, y) => {
    const nodeRow = expanded[y]?.nodeRow;
    let output = "";
    let mode: "edge" | "marker" | "title" | "muted-title" = "edge";
    let segment = "";
    const flush = (): void => {
      if (segment.length === 0) return;
      output += mode === "marker" ? palette.bold(graphNodeStyle(nodeRow?.node.type ?? "", segment, palette))
        : mode === "title" ? palette.muted(segment)
          : mode === "muted-title" ? palette.dim(segment)
            : palette.border(segment);
      segment = "";
    };
    cells.forEach((cell, x) => {
      const nextMode = nodeRow === undefined || x < nodeRow.markerStart ? "edge"
        : x < nodeRow.markerEnd ? "marker"
          : x >= nodeRow.titleStart && cell.trim().length > 0
            ? nodeRow.node.muted ? "muted-title" : "title"
            : "edge";
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

function drawGraphHorizontal(canvas: string[][], y: number, from: number, to: number): void {
  const left = Math.min(from, to);
  const right = Math.max(from, to);
  for (let x = left; x <= right; x += 1) mergeGraphCell(canvas, y, x, "─");
}

function drawGraphVertical(canvas: string[][], x: number, from: number, to: number): void {
  const top = Math.min(from, to);
  const bottom = Math.max(from, to);
  for (let y = top; y <= bottom; y += 1) mergeGraphCell(canvas, y, x, "│");
}

function mergeGraphCell(canvas: string[][], y: number, x: number, value: string): void {
  const row = canvas[y];
  if (row === undefined || x < 0 || x >= row.length) return;
  const previous = row[x];
  row[x] = previous === " " || previous === value ? value : "┼";
}

function writeGraphText(row: string[], start: number, value: string): void {
  let x = start;
  for (const grapheme of graphGraphemes(value)) {
    const cells = Math.max(0, visibleWidth(grapheme));
    if (cells === 0 || x + cells > row.length) break;
    row[x] = grapheme;
    for (let offset = 1; offset < cells; offset += 1) row[x + offset] = "";
    x += cells;
  }
}

function normalizeGraphEdges(
  edges: readonly { source: string; target: string; relation?: string }[],
  byId: ReadonlyMap<string, GraphNodeView>,
  reverseDisplayEdges: Readonly<Record<string, string>> | undefined,
  compareNodes: (left: GraphNodeView, right: GraphNodeView) => number,
): GraphDisplayEdge[] {
  const valid = edges
    .filter((edge) => edge.source !== edge.target && byId.has(edge.source) && byId.has(edge.target))
    .map((edge) => {
      const relation = edge.relation ?? "related";
      const sourceType = byId.get(edge.source)!.type;
      const reversed = reverseDisplayEdges?.[`${sourceType}.${relation}`];
      return reversed === undefined
        ? { source: edge.source, target: edge.target, relation }
        : { source: edge.target, target: edge.source, relation: reversed };
    })
    .sort((left, right) => graphEdgeKey(left).localeCompare(graphEdgeKey(right)));
  const byPair = new Map<string, GraphDisplayEdge[]>();
  for (const edge of valid) {
    const pair = [edge.source, edge.target].sort().join("\u0000");
    const list = byPair.get(pair) ?? [];
    list.push(edge);
    byPair.set(pair, list);
  }
  const output: GraphDisplayEdge[] = [];
  for (const pairEdges of byPair.values()) {
    const directions = new Set(pairEdges.map((edge) => `${edge.source}\u0000${edge.target}`));
    const reciprocal = directions.size > 1;
    if (!reciprocal) {
      const seen = new Set<string>();
      for (const edge of pairEdges) {
        const key = graphEdgeKey(edge);
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(edge);
      }
      continue;
    }
    const [leftId, rightId] = [pairEdges[0]!.source, pairEdges[0]!.target].sort((left, right) =>
      compareNodes(byId.get(left)!, byId.get(right)!));
    const forward = pairEdges.filter((edge) => edge.source === leftId && edge.target === rightId);
    const labels = [...new Set((forward.length > 0 ? forward : pairEdges).map((edge) => edge.relation))].sort();
    output.push({ source: leftId!, target: rightId!, relation: labels.join("/") || "related" });
  }
  return output.sort((left, right) => graphEdgeKey(left).localeCompare(graphEdgeKey(right)));
}

function choosePrimaryGraphEdges(
  edges: readonly GraphDisplayEdge[],
  byId: ReadonlyMap<string, GraphNodeView>,
  compareNodes: (left: GraphNodeView, right: GraphNodeView) => number,
  primaryParentPreferences: Readonly<Record<string, readonly string[]>> | undefined,
): Map<string, GraphDisplayEdge> {
  const output = new Map<string, GraphDisplayEdge>();
  const sorted = [...edges].sort((left, right) =>
    compareNodes(byId.get(left.target)!, byId.get(right.target)!) ||
    parentPreferenceRank(left, byId, primaryParentPreferences) - parentPreferenceRank(right, byId, primaryParentPreferences) ||
    compareNodes(byId.get(left.source)!, byId.get(right.source)!) ||
    left.relation.localeCompare(right.relation));
  for (const edge of sorted) {
    if (output.has(edge.target)) continue;
    let ancestor: string | undefined = edge.source;
    let cyclic = false;
    while (ancestor !== undefined) {
      if (ancestor === edge.target) {
        cyclic = true;
        break;
      }
      ancestor = output.get(ancestor)?.source;
    }
    if (!cyclic) output.set(edge.target, edge);
  }
  return output;
}

function parentPreferenceRank(
  edge: GraphDisplayEdge,
  byId: ReadonlyMap<string, GraphNodeView>,
  preferences: Readonly<Record<string, readonly string[]>> | undefined,
): number {
  const childType = byId.get(edge.target)?.type;
  const parentType = byId.get(edge.source)?.type;
  if (childType === undefined || parentType === undefined) return Number.MAX_SAFE_INTEGER;
  const order = preferences?.[childType];
  const index = order?.indexOf(parentType) ?? -1;
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function graphNodeCompare(left: GraphNodeView, right: GraphNodeView, hierarchy?: readonly string[]): number {
  return graphTypeRank(left.type, hierarchy) - graphTypeRank(right.type, hierarchy) ||
    left.type.localeCompare(right.type) || left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
}

function graphTypeRank(type: string, configured?: readonly string[]): number {
  const normalized = type.toLocaleLowerCase("en-US");
  const order = configured ?? [
    "goal", "objective", "problem", "requirement", "architecture", "decision", "change",
    "hypothesis", "claim", "literature", "method", "experiment", "ablation", "implementation",
    "metric", "evidence", "result", "verification", "gate", "report",
  ];
  const index = order.findIndex((candidate) => normalized === candidate || normalized.includes(candidate));
  return index < 0 ? order.length : index;
}

function graphEdgeKey(edge: GraphDisplayEdge): string {
  return `${edge.source}\u0000${edge.relation}\u0000${edge.target}`;
}

function formatGraphRelation(value: string): string {
  const normalized = value
    .replace(/^target_claims$/u, "claims")
    .replace(/^tested_by$/u, "tests")
    .replace(/^applies_to$/u, "applies")
    .replace(/^negative_evidence$/u, "neg-evidence")
    .replace(/^change_requests$/u, "changes")
    .replace(/_/gu, "-");
  return truncateToWidth(normalized, 18, "…");
}

function compactGraphPrefix(prefix: string, width: number): string {
  const budget = Math.max(3, Math.min(12, Math.floor(width / 3)));
  if (visibleWidth(prefix) <= budget) return prefix;
  return `…${truncateToWidth(prefix.slice(-(budget - 1)), budget - 1, "")}`;
}

function graphBadge(type: string, width: number): string {
  if (width >= 48) return `[${truncateToWidth(type.replace(/_/gu, "-"), Math.max(1, width - 2), "…")}]`;
  const known: Readonly<Record<string, string | undefined>> = {
    hypothesis: "hy", literature: "li", paper: "pa", claim: "cl", experiment: "ex",
    method: "mt", metric: "me", prerequisite: "pr", decision: "de", ablation: "ab",
    asset: "as", gate: "gt", implementation: "im", run: "rn", evidence: "ev",
    report: "rp", "change-request": "cr",
  };
  const normalized = type.toLocaleLowerCase("en-US").replace(/_/gu, "-");
  const initials = normalized.split("-").map((part) => part[0] ?? "").join("").slice(0, 2);
  const fallback = Array.from(normalized).filter((character) => /[\p{L}\p{N}]/u.test(character)).slice(0, 2).join("");
  return `[${known[normalized] ?? initials.padEnd(2, fallback[1] ?? fallback[0] ?? "?")}]`;
}

function graphNodeStyle(type: string, value: string, palette: KoniPalette): string {
  const styles = [palette.accent, palette.info, palette.success, palette.warning, palette.error] as const;
  const hash = Array.from(type).reduce((total, character) => total + (character.codePointAt(0) ?? 0), 0);
  return styles[hash % styles.length]!(value);
}

function graphGraphemes(value: string): string[] {
  if (Intl.Segmenter === undefined) return Array.from(value);
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map((entry) => entry.segment);
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

function annotateOperateHitTargets(
  frame: CellGrid,
  layout: OperateLayout,
  snapshot: ControlCenterControllerSnapshot,
): void {
  const selectedRunIndex = Math.max(0, snapshot.view.runs.findIndex((run) => run.id === snapshot.selection.runId));
  addTwoLineListTargets({
    frame,
    rect: layout.runs,
    ids: snapshot.view.runs.map((run) => `run:${run.id}`),
    selectedLine: selectedRunIndex * 2,
    scroll: snapshot.scroll.runs,
    fixedFooter: true,
    leadingLines: 0,
  });

  const tickets = snapshot.view.selectedRun?.tickets ?? [];
  const selectedTicketIndex = Math.max(0, tickets.findIndex((ticket) => ticket.id === snapshot.selection.ticketId));
  addTwoLineListTargets({
    frame,
    rect: layout.tickets,
    ids: tickets.map((ticket) => `ticket:${ticket.id}`),
    selectedLine: 1 + selectedTicketIndex * 2,
    scroll: snapshot.scroll.tickets,
    fixedFooter: false,
    leadingLines: 1,
  });

  const agents = snapshot.view.selectedRun?.agents ?? [];
  const selectedAgentIndex = Math.max(0, agents.findIndex((agent) => agent.id === snapshot.selection.attemptId));
  addTwoLineListTargets({
    frame,
    rect: layout.agents,
    ids: agents.map((agent) => `agent:${agent.id}`),
    selectedLine: selectedAgentIndex * 2,
    scroll: snapshot.scroll.agents,
    fixedFooter: false,
    leadingLines: 0,
  });
}

function annotateOperateControlHitTargets(
  frame: CellGrid,
  layout: OperateLayout,
  snapshot: ControlCenterControllerSnapshot,
): void {
  for (const tab of ["overview", "plan", "stages"] as const) {
    frame.addTextHitTarget(`details-tab:${tab}`, titleCaseLabel(tab), layout.details);
  }
  frame.addTextHitTarget("ticket-tab:previous", "‹", layout.tickets);
  frame.addTextHitTarget("ticket-tab:next", "›", layout.tickets);
  const question = snapshot.view.selectedRun?.questions?.[snapshot.questionIndex];
  if (question === undefined || layout.questions === undefined) return;
  question.options.forEach((option, index) => {
    frame.addTextHitTarget(`question-option:${index}`, option.label, layout.questions);
  });
  frame.addTextHitTarget("question-option:none", "None of the above", layout.questions);
  frame.addTextHitTarget("question:open", "Enter", layout.questions);
}

function annotateConfigureHitTargets(
  frame: CellGrid,
  layout: ConfigureScreenLayout,
  snapshot: ControlCenterControllerSnapshot,
  configure: ConfigureModalState,
): void {
  const nested = snapshot.modal?.kind !== "configure" || configure.resourceOperation !== undefined;
  if (nested) {
    annotateModalHitTargets(frame, snapshot);
    return;
  }
  configure.catalog.sections.forEach((section, index) => {
    frame.addTextHitTarget(`config:domain:${index}`, section.title, layout.domains);
  });
  const section = configure.catalog.sections[configure.sectionIndex];
  section?.resources.forEach((resource, index) => {
    frame.addTextHitTarget(`config:resource:${index}`, resource.title, layout.resources);
  });
  section?.resources[configure.resourceIndex]?.fields.forEach((field, index) => {
    frame.addTextHitTarget(`config:field:${index}`, field.label, layout.editor);
  });
  frame.addTextHitTarget("config:publish", "Validate & publish", layout.draftBar);
}

function annotateConfigureDocumentHitTargets(
  frame: CellGrid,
  layout: ConfigureScreenLayout,
  snapshot: ControlCenterControllerSnapshot,
  configure: ConfigureDocumentsModalState,
): void {
  if (snapshot.modal?.kind !== "configure_documents") {
    annotateModalHitTargets(frame, snapshot);
    return;
  }
  CONFIG_DOCUMENT_DOMAINS.forEach((domain, index) => {
    frame.addTextHitTarget(`config-doc:domain:${index}`, titleCaseLabel(domain), layout.domains);
  });
  const domain = CONFIG_DOCUMENT_DOMAINS[configure.domainIndex];
  configure.catalog.documents
    .filter((document) => document.domain === domain)
    .forEach((document, index) => {
      frame.addTextHitTarget(`config-doc:document:${index}`, document.title, layout.resources);
    });
  frame.addTextHitTarget("config-doc:editor", "Source Editor", layout.editor);
  if (configure.dirty) {
    frame.addTextHitTarget("config-doc:save", "Validate & save", layout.draftBar);
    frame.addTextHitTarget("config-doc:discard", "Discard", layout.draftBar);
  } else {
    frame.addTextHitTarget("config-doc:create", "New", layout.draftBar);
    frame.addTextHitTarget("config-doc:rename", "Rename", layout.draftBar);
    frame.addTextHitTarget("config-doc:delete", "Delete", layout.draftBar);
    frame.addTextHitTarget("config-doc:run-type", "Run type", layout.draftBar);
    frame.addTextHitTarget("config-doc:migration", "Legacy migration", layout.draftBar);
    frame.addTextHitTarget("config-doc:guided", "Guided", layout.draftBar);
  }
}

function annotateModalHitTargets(frame: CellGrid, snapshot: ControlCenterControllerSnapshot): void {
  const modal = snapshot.modal;
  if (modal === undefined) return;
  if (modal.kind === "help") {
    frame.addTextHitTarget("modal:close", "close");
  } else if (modal.kind === "delete") {
    frame.addTextHitTarget("delete:cancel", "Cancel");
    frame.addTextHitTarget("delete:preserve", "Preserve branches");
    frame.addTextHitTarget("delete:owned", "Delete owned branches");
  } else if (modal.kind === "merge") {
    frame.addTextHitTarget("merge:cancel", "Cancel");
    frame.addTextHitTarget("merge:authorize", "Authorize merge");
  } else if (modal.kind === "new_run") {
    snapshot.runTypes.forEach((runType, index) => {
      frame.addTextHitTarget(`new-run:type:${index}`, runType.title);
    });
    for (const policy of ["none", "some", "many"] as const) {
      frame.addTextHitTarget(`new-run:questions:${policy}`, policy);
    }
    frame.addTextHitTarget("new-run:objective", "Goal Prompt");
    frame.addTextHitTarget("new-run:branch", "Target branch");
    frame.addTextHitTarget("new-run:parallel", "Max parallel agents");
    const selected = snapshot.runTypes.find((runType) => runType.id === modal.runTypeId);
    frame.addTextHitTarget("new-run:start", selected?.startMode === "work" ? "Start Work" : "Start Planning");
  } else if (modal.kind === "plan_review") {
    const sections = snapshot.view.selectedRun?.approval?.sections ?? [];
    sections.forEach((section, index) => frame.addTextHitTarget(`plan:section:${index}`, section.title));
    frame.addTextHitTarget("plan:steering", "Steering instructions");
    frame.addTextHitTarget("plan:action", modal.steering.trim().length > 0 ? "Revise plan" : "Approve run");
  } else if (modal.kind === "proposal_review") {
    frame.addTextHitTarget("proposal:message", "Decision message (optional)");
    frame.addTextHitTarget("proposal:approve", "Approve proposal");
    frame.addTextHitTarget("proposal:reject", "Reject proposal");
    frame.addTextHitTarget(
      "proposal:submit",
      modal.decision === "approval" ? "Record approval" : modal.decision === "rejection" ? "Record rejection" : "Choose a decision",
    );
  } else if (modal.kind === "answer_question") {
    const question = snapshot.view.selectedRun?.questions?.find((candidate) => candidate.id === modal.questionId);
    question?.options.forEach((option, index) => frame.addTextHitTarget(`answer:option:${index}`, option.label));
    frame.addTextHitTarget("answer:option:none", "None of the above");
    frame.addTextHitTarget("answer:notes", "Notes (optional)");
    frame.addTextHitTarget("answer:submit", "Submit answer");
  } else if (modal.kind === "action_palette") {
    modal.actions.forEach((action, index) => frame.addTextHitTarget(`action-palette:${index}`, action.title));
  } else if (modal.kind === "action_form") {
    modal.action.form?.fields.forEach((field, index) => {
      if (field.visibility !== "hidden") frame.addTextHitTarget(`action-field:${index}`, field.label);
    });
    if (modal.action.confirmation.required) {
      frame.addTextHitTarget("action-confirm", modal.action.confirmation.confirmLabel);
    }
    frame.addTextHitTarget("action-submit", modal.action.form?.submitLabel ?? modal.action.title);
  } else if (modal.kind === "config_document_create") {
    modal.choices.forEach((choice, index) => frame.addTextHitTarget(`config-create:choice:${index}`, choice.label));
    frame.addTextHitTarget("config-create:title", "Title");
    frame.addTextHitTarget("config-create:submit", "Create resource");
  } else if (modal.kind === "config_document_rename") {
    frame.addTextHitTarget("config-rename:title", "Title");
    frame.addTextHitTarget("config-rename:submit", "Rename resource");
  } else if (modal.kind === "config_document_delete") {
    frame.addTextHitTarget("config-delete:cancel", "Cancel");
    frame.addTextHitTarget("config-delete:confirm", "Delete resource");
  } else if (modal.kind === "config_run_type_wizard") {
    modal.templates.templates.forEach((template, index) => frame.addTextHitTarget(`config-run-type:template:${index}`, template.title));
    frame.addTextHitTarget("config-run-type:title", "Title");
    frame.addTextHitTarget("config-run-type:slug", "Slug");
    frame.addTextHitTarget("config-run-type:description", "Description");
    frame.addTextHitTarget("config-run-type:default", "Make this the project default");
    frame.addTextHitTarget("config-run-type:submit", "Create run type");
  } else if (modal.kind === "config_legacy_migration") {
    frame.addTextHitTarget("config-migration:cancel", "Cancel");
    frame.addTextHitTarget("config-migration:apply", "Apply migration");
  } else if (modal.kind === "profile_conflicts") {
    frame.addTextHitTarget("conflict:action:project", "Keep project");
    frame.addTextHitTarget("conflict:action:upstream", "Use update");
  } else if (modal.kind === "configure" && modal.resourceOperation !== undefined) {
    const button = modal.resourceOperation.kind === "create" ? "Create resource"
      : modal.resourceOperation.kind === "duplicate" ? "Duplicate resource" : "Delete resource";
    frame.addTextHitTarget("config:resource-operation", button);
  }
}

function titleCaseLabel(value: string): string {
  return value.replace(/[-_]+/gu, " ").replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function addTwoLineListTargets(input: {
  frame: CellGrid;
  rect: { x: number; y: number; width: number; height: number };
  ids: readonly string[];
  selectedLine: number;
  scroll: number;
  fixedFooter: boolean;
  leadingLines: number;
}): void {
  if (input.ids.length === 0) return;
  const capacity = Math.max(1, input.rect.height - (input.fixedFooter ? 3 : 2));
  const contentLines = input.leadingLines + input.ids.length * 2;
  const requested = visibleOffset(input.scroll, input.selectedLine, capacity);
  const start = Math.min(Math.max(0, requested), Math.max(0, contentLines - capacity));
  input.ids.forEach((id, index) => {
    const contentLine = input.leadingLines + index * 2;
    const row = contentLine - start;
    if (row >= capacity || row + 1 < 0) return;
    const visibleStart = Math.max(0, row);
    const visibleEnd = Math.min(capacity, row + 2);
    const y = input.rect.y + 1 + visibleStart;
    const height = visibleEnd - visibleStart;
    if (height <= 0) return;
    input.frame.addHitTarget(id, {
      x: input.rect.x + 1,
      y,
      width: Math.max(0, input.rect.width - 2),
      height,
    });
  });
}

function panelFromHitTarget(target: string): ControlCenterPanel | undefined {
  if (!target.startsWith("panel:")) return undefined;
  const panel = target.slice("panel:".length);
  return new Set<ControlCenterPanel>(["runs", "tickets", "agents", "details", "questions", "activity", "graph"])
    .has(panel as ControlCenterPanel)
    ? panel as ControlCenterPanel
    : undefined;
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
    description: "Pending questions pause the responsible attempt. The inline panel previews the same choices, descriptions, None option, and notes used by the complete answer dialog.",
    actions: [["↑/↓ or j/k", "choose option"], ["←/→ or [ ]", "switch question"], ["n", "edit notes"], ["Enter", "open the answer dialog"]],
  },
  agents: {
    title: "Agents",
    description: "Active and past attempts remain visible as a semantic lineage tree. Run-wide rows include their ticket prefix; selecting a ticket narrows the list. Retry, rework, review, recovery, parent/child, and active-leaf context never exposes internal IDs.",
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
  proposal_review: {
    title: "Review Change Proposal",
    description: "A model may propose an upstream graph or specification change, but only the compiler publishes this bounded review and only you may approve or reject it. The surface starts with no selected outcome.",
    actions: [["↑/↓ or j/k", "read the complete proposal"], ["Tab", "move through message, choice, and action"], ["←/→", "choose approval or rejection"], ["Ctrl-Enter", "record the reviewed decision"]],
  },
  answer_question: {
    title: "Answer Question",
    description: "Questions are durable compiler-owned decisions. Compare every option and its description, choose None of the above when needed, add optional steering notes, then submit explicitly.",
    actions: [["←/→ or [ ]", "switch pending question"], ["↑/↓ or j/k", "choose an option"], ["Tab", "move to notes or submit"], ["Ctrl-Enter", "submit the selected answer and notes"]],
  },
  action_palette: {
    title: "Actions",
    description: "This palette is authored from current compiler and lifecycle state. Disabled actions stay visible with the exact reason; delete and merge always open their guarded review before any mutation.",
    actions: [["↑/↓ or j/k", "choose an action"], ["Enter", "open or execute an available action"], ["Esc", "close without changing state"]],
  },
  action_form: {
    title: "Action Form",
    description: "The compiler defines these semantic fields and locked context. Inputs are submitted with the exact run revision and generation; stale or altered requests fail closed at authority.",
    actions: [["Tab or ↑/↓", "move between fields and action"], ["←/→", "change a selector or number"], ["Enter", "edit, select, or confirm"], ["Ctrl-Enter", "submit explicitly"]],
  },
  configure: {
    title: "Configure",
    description: "Guided domains edit an in-memory project-overlay draft. Koni never makes YAML the primary interface. Publish sends the complete candidate and source-CAS token to authority; active and pinned runs are unchanged by a draft.",
    actions: [["←/→", "change section, value, or action"], ["↑/↓", "choose resource or field"], ["r", "open semantic Project Resources"], ["u", "review staged upstream changes"], ["a / d / x", "add, duplicate, or delete resource"], ["Ctrl-S", "save in-memory draft"], ["Ctrl-R", "rebase a stale saved draft"], ["Ctrl-P", "validate and publish"], ["Ctrl-D", "discard draft"]],
  },
  configure_documents: {
    title: "Project Resources",
    description: "This expert surface groups exact project-authored configuration by semantic domain. It edits source through authority-owned document and revision tokens; filesystem paths and compiler-owned files are never exposed as UI authority.",
    actions: [["Tab", "move between domains, resources, and source"], ["Enter", "start or stop source editing"], ["Ctrl-S", "validate and save the exact document"], ["Ctrl-D", "discard the raw edit"], ["a / e / x", "create, rename, or review deletion"], ["t", "create a run type from a compiled template"], ["l", "preview legacy migration"], ["Esc", "return to Guided Configure when clean"]],
  },
  config_document_create: {
    title: "New Project Resource",
    description: "Create one supported project-owned resource from a semantic type. Authority chooses its managed location, compiles the complete candidate, and publishes only a valid result.",
    actions: [["←/→ or [ ]", "choose a resource type"], ["Tab", "move to title or action"], ["Enter", "continue or create"], ["Esc", "return without creating"]],
  },
  config_document_rename: {
    title: "Rename Project Resource",
    description: "Rename the selected semantic resource under exact catalog and source revision checks. Required references are updated atomically by the configuration authority.",
    actions: [["←/→", "move the title caret"], ["Tab", "move to the action"], ["Enter", "continue or rename"], ["Esc", "return without renaming"]],
  },
  config_document_delete: {
    title: "Delete Project Resource",
    description: "Deletion is a reviewed, compiler-validated operation. The dialog keeps unavailable deletion visible with the authority-authored reason and cannot bypass that decision.",
    actions: [["←/→", "choose Cancel or Delete"], ["Enter", "confirm the selected action"], ["Esc", "return without deleting"]],
  },
  config_run_type_wizard: {
    title: "New Run Type",
    description: "Create a project run type by cloning a compiler-valid template, then give it a human title, optional slug and description, and an explicit default choice.",
    actions: [["←/→", "choose a template or edit the caret"], ["Tab/↑/↓", "move between fields"], ["Enter", "continue, toggle, or add a description line"], ["Ctrl-Enter", "create the run type"], ["Esc", "return without creating"]],
  },
  config_legacy_migration: {
    title: "Legacy Migration",
    description: "This preview counts the legacy configuration, external agents, and runs that will be imported. Apply revalidates the exact preview and retains the original source for recovery and audit.",
    actions: [["←/→", "choose Cancel or Apply"], ["Enter", "apply the reviewed migration"], ["Esc", "return without migrating"]],
  },
  profile_conflicts: {
    title: "Upstream Changes",
    description: "Profile upgrades preserve project overrides and stage upstream changes for an explicit decision. Compare the complete project and upstream documents, then keep the project version or accept the authenticated update under source and lifecycle checks.",
    actions: [["↑/↓ or j/k", "switch changed resource"], ["PgUp/PgDn", "scroll both documents"], ["Tab", "focus resolution actions"], ["←/→", "choose Keep project or Use update"], ["Enter", "apply the selected decision"], ["Esc", "return to Configure"]],
  },
  edit_scalar: {
    title: "Edit Setting",
    description: "This editor changes only the in-memory Configure draft. Its Unicode caret moves by complete characters, the complete wrapped value remains reachable, and schema validation runs before the draft is updated.",
    actions: [["←/→", "move the caret"], ["Home/End", "move to either boundary"], ["Backspace/Delete", "remove text around the caret"], ["Enter/Ctrl-Enter", "apply a scalar/multiline value"], ["Esc", "return without changing the draft"]],
  },
  chat: {
    title: "Agent Chat",
    description: "This is the persisted Pi session itself: complete assistant messages, reasoning, calls, results, compaction, and branch points. Large items remain complete as ordered bounded parts. Only terminal and invisible-direction controls are stripped or replaced for safe display; canonical Pi JSONL is unchanged. Image bytes stay private while an ordered type-and-size attachment row remains visible. Steering and follow-ups still cross Koni authority before Pi receives them.",
    actions: [["←/→ or [ ]", "move to adjacent older/newer history windows"], ["PgUp/PgDn", "scroll within the current bounded window"], ["r", "reload the current newest history"], ["Enter or s", "open the composer"], ["Tab", "switch steer/follow-up"], ["Ctrl-Enter", "send through authority"], ["Esc", "close the composer, then exit Chat"]],
  },
};
