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
import { formatTokens, type ControlCenterViewModel } from "./view-model.js";
import { sealedModelAdmissionIssue } from "../pi/model-catalog.js";
import {
  decodeControlCenterPointer,
  decodeControlCenterInput,
  type ControlCenterPanel,
  type ControlCenterPointerInput,
} from "./input.js";
import {
  ansiKoniPalette,
  type KoniChipTone,
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
  type ControlCenterHelpTopic,
  type EditScalarModalState,
  configResourceActions,
  type GraphNodeModalState,
  type DeleteRunModalState,
  type MergeRunModalState,
  type NewRunModalState,
  type PlanReviewModalState,
  type ProposalReviewModalState,
  type ProfileConflictsModalState,
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
import { cockpitView } from "./cockpit-config.js";
import {
  configuredGraphOptions,
  graphBadge,
  graphNodeStyle,
  formatGraphRelation,
} from "./graph-view.js";
import { feedLayout, renderGraphFeed } from "./graph-feed.js";

export {
  configuredGraphOptions,
  graphOutlineNodes,
  renderGraphLines,
  renderGraphView,
  type GraphRenderOptions,
  type GraphViewResult,
} from "./graph-view.js";

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
  /** Viewport-relative card title rows from the last Graph-feed render, for pointer targets. */
  #graphFeedTicketLines: readonly { id: string; row: number }[] = [];

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
    this.#ticker =
      this.#requestRender === undefined
        ? undefined
        : setInterval(() => {
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
        this.#lastFrame = CellGrid.fromAnsiLines(
          resizeScreen(safeWidth, safeRows, this.#palette),
          safeWidth,
          safeRows,
        ).addRegion("resize", configureGeometry.screen);
        return this.#lastFrame;
      }
      let configured =
        configure.kind === "configure"
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
      } else if (
        this.#snapshot.modal !== undefined &&
        this.#snapshot.modal.kind !== configure.kind
      ) {
        configured = overlayModal(
          configured,
          this.#renderModal(Math.max(24, Math.min(118, safeWidth - 4)), Math.max(12, safeRows - 4)),
          safeWidth,
        );
      }
      const frame = CellGrid.fromAnsiLines(
        fitRows(configured, safeWidth, safeRows),
        safeWidth,
        safeRows,
      );
      frame.addRegion("header", configureGeometry.header);
      frame.addRegion("config.domains", configureGeometry.domains, "config:domains");
      frame.addRegion("config.resources", configureGeometry.resources, "config:resources");
      frame.addRegion("config.editor", configureGeometry.editor, "config:editor");
      frame.addRegion("config.draft", configureGeometry.draftBar, "config:draft");
      frame.addRegion("footer", configureGeometry.footer);
      if (
        (this.#snapshot.modal !== undefined && this.#snapshot.modal.kind !== configure.kind) ||
        (configure.kind === "configure" && configure.resourceOperation !== undefined)
      ) {
        frame.addHitTarget("modal", { x: 0, y: 0, width: safeWidth, height: safeRows });
      }
      if (configure.kind === "configure")
        annotateConfigureHitTargets(frame, configureGeometry, this.#snapshot, configure);
      else annotateConfigureDocumentHitTargets(frame, configureGeometry, this.#snapshot, configure);
      this.#lastFrame = frame;
      return frame;
    }

    const rendered = this.#renderOperate(layout);
    const withModal =
      this.#snapshot.modal === undefined
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
    frame.addRegion("runs", layout.runs, "panel:runs");
    frame.addRegion("tickets", layout.tickets, "panel:tickets");
    frame.addRegion("agents", layout.agents, "panel:agents");
    frame.addRegion("details", layout.details, "panel:details");
    if (layout.questions !== undefined)
      frame.addRegion("questions", layout.questions, "panel:questions");
    frame.addRegion("activity", layout.activity, "panel:activity");
    frame.addRegion("footer", layout.footer);
    annotateOperateHitTargets(frame, layout, this.#snapshot);
    if (this.#snapshot.modal !== undefined) {
      frame.addHitTarget("modal", { x: 0, y: 0, width: safeWidth, height: safeRows });
      annotateModalHitTargets(frame, this.#snapshot);
    } else {
      annotateOperateControlHitTargets(frame, layout, this.#snapshot);
      this.#annotateGraphFeedHitTargets(frame, layout);
    }
    this.#lastFrame = frame;
    return frame;
  }

  #handlePointer(pointer: ControlCenterPointerInput): void {
    const target = this.#lastFrame?.hitTargetAt(pointer.x, pointer.y);
    if (target === undefined) return;
    const panel = panelFromHitTarget(target);
    if (pointer.kind === "wheel") {
      if (panel !== undefined)
        void this.#controller.handle({ type: "pointer_scroll", panel, delta: pointer.delta });
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
      ...this.#activityPanel(layout.activity.width, layout.activity.height),
    ];
    const right =
      layout.questions === undefined
        ? this.#detailsPanel(layout.details.width, layout.details.height)
        : [
            ...this.#detailsPanel(layout.details.width, layout.details.height),
            ...this.#questionsPanel(layout.questions.width, layout.questions.height),
          ];
    const bodyHeight = layout.footer.y;
    return [
      ...joinColumns([left, right], [layout.runs.width, layout.details.width], bodyHeight),
      ...this.#footer(layout.width),
    ];
  }

  #header(width: number, mode: "CONFIGURE" | "PROJECT RESOURCES"): string[] {
    const run = this.#snapshot.view.selectedRun;
    const metadata =
      run === undefined
        ? this.#palette.muted("No runs yet")
        : [
            this.#palette.accent(run.header.runType),
            `${run.spendingTokens ? `${this.#animatedCog()} ` : ""}${run.header.stage}`,
            `${run.header.ticketCount} tickets`,
            run.header.newTokens,
            ...(run.header.awaitingApproval ? [this.#palette.warning("approval needed")] : []),
            ...(this.#snapshot.cockpitIssue === undefined
              ? []
              : [this.#palette.warning("view config unavailable")]),
          ].join(this.#palette.muted(" · "));
    const title = `${this.#palette.bold(this.#palette.accent(" KONI "))} ${this.#palette.accent(mode)} ${this.#palette.text(`project:${this.#snapshot.view.projectRoot}`)}`;
    return framedHeader(title, metadata, width, this.#palette);
  }

  #renderConfigureScreen(modal: ConfigureModalState, layout: ConfigureScreenLayout): string[] {
    const section = modal.catalog.sections[modal.sectionIndex];
    const resource = section?.resources[modal.resourceIndex];
    const domains = modal.catalog.sections.map((candidate, index) =>
      configDomainRow(candidate.id, candidate.title, index === modal.sectionIndex, this.#palette),
    );
    const resourceList = section?.resources ?? [];
    const resources: string[] = [];
    let selectedResourceLine = 0;
    let lastGroup: string | undefined;
    resourceList.forEach((candidate, index) => {
      const group = candidate.group;
      if (group !== undefined && group !== lastGroup) {
        if (resources.length > 0) resources.push("");
        resources.push(this.#palette.muted(group));
        lastGroup = group;
      }
      const depth = Math.max(0, candidate.depth ?? 0);
      const next = resourceList[index + 1];
      const connector =
        depth === 0 ? "" : next === undefined || (next.depth ?? 0) < depth ? "└─ " : "├─ ";
      const indent = "  ".repeat(depth === 0 ? 0 : depth - 1);
      const selected = index === modal.resourceIndex;
      if (selected) selectedResourceLine = resources.length;
      const dirty = configResourceDirty(candidate.fields, modal);
      if (selected) {
        resources.push(
          this.#palette.selected(`▸ ${indent}${connector}${dirty ? "● " : ""}${candidate.title}`),
        );
        return;
      }
      const rail = this.#palette.dim(`${indent}${connector}`);
      const badge = dirty ? `${this.#palette.warning("●")} ` : "";
      resources.push(`  ${rail}${badge}${this.#palette.text(candidate.title)}`);
    });
    if (resources.length === 0) resources.push(this.#palette.dim("No resources in this domain."));

    const editor: string[] = [];
    if (modal.upstreamConflicts.conflicts.length > 0) {
      editor.push(
        this.#palette.warning(
          `${modal.upstreamConflicts.conflicts.length} upstream ${modal.upstreamConflicts.conflicts.length === 1 ? "change needs" : "changes need"} review · [u] Open comparison`,
        ),
        "",
      );
    }
    if (resource === undefined)
      editor.push(this.#palette.muted("Select a resource to inspect its settings."));
    else {
      editor.push(sectionHeading(resource.title, this.#palette));
      editor.push(
        ...wrapStyled(
          resource.description,
          Math.max(1, layout.editor.width - 2),
          this.#palette.muted,
        ),
        "",
      );
      resource.fields.forEach((field, index) => {
        const selected = index === modal.fieldIndex;
        const value = configValueLabel(field, modal.draft[field.key], this.#snapshot.models);
        const chip = inputBadge(
          value,
          selected && modal.focus === "field",
          this.#palette,
          configScalarTint(field.kind, this.#palette),
        );
        const caret = selected ? this.#palette.accent("▸") : " ";
        const name = selected ? this.#palette.bold(field.label) : this.#palette.text(field.label);
        const mark = configFieldDirty(field, modal) ? ` ${this.#palette.warning("●")}` : "";
        editor.push(`${caret} ${name}${mark}  ${chip}`);
        if (!selected) {
          const summary = (field.description.split("\n")[0] ?? "").trim();
          if (summary.length > 0) {
            editor.push(
              `   ${this.#palette.dim(truncateToWidth(summary, Math.max(1, layout.editor.width - 5), "…"))}`,
            );
          }
        }
        if (selected) {
          editor.push(
            ...wrapStyled(
              field.description,
              Math.max(1, layout.editor.width - 5),
              (line) => `   ${this.#palette.dim(line)}`,
            ),
          );
          if (isConfigTextField(field)) {
            const source =
              modal.textEditor?.key === field.key ? modal.textEditor.value : modal.draft[field.key];
            const valueText =
              typeof source === "string"
                ? source
                : Array.isArray(source)
                  ? source.filter((item): item is string => typeof item === "string").join("\n")
                  : "";
            editor.push(
              ...wrapStyled(
                `${modal.editing ? "▌ " : "  "}${valueText.length === 0 ? this.#palette.dim("Empty") : valueText}`,
                Math.max(1, layout.editor.width - 4),
                (line) => (selected ? this.#palette.selected(line) : line),
              ),
            );
          }
        }
      });
      const resourceActions = configResourceActions(modal);
      if (resourceActions.length > 0) {
        editor.push(
          "",
          resourceActions
            .map((action) => {
              if (action === "create") return "[a] Add";
              if (action === "duplicate") return "[d] Duplicate";
              return "[x] Delete";
            })
            .join("  "),
        );
      }
    }

    const content = [
      ...this.#header(layout.width, "CONFIGURE"),
      ...joinColumns(
        [
          panel(
            "Domains",
            domains,
            layout.domains.width,
            layout.domains.height,
            modal.focus === "tree",
            this.#palette,
          ),
          panel(
            section?.title ?? "Resources",
            resources,
            layout.resources.width,
            layout.resources.height,
            modal.focus === "tree",
            this.#palette,
            visibleOffset(0, selectedResourceLine, Math.max(1, layout.resources.height - 2)),
          ),
          panel(
            "Editor",
            editor,
            layout.editor.width,
            layout.editor.height,
            modal.focus === "field" || modal.focus === "actions",
            this.#palette,
          ),
        ],
        [layout.domains.width, layout.resources.width, layout.editor.width],
        layout.domains.height,
      ),
      ...panel(
        "Configuration",
        [
          centerLine(
            modal.rebaseRequired
              ? "Saved draft is stale · Ctrl-R rebase · Ctrl-D discard"
              : `${modal.dirty ? "● unpublished changes" : "configuration current"} · Ctrl-S save · Ctrl-P publish · Ctrl-D discard · [r] Project Resources`,
            Math.max(1, layout.width - 2),
            modal.rebaseRequired || modal.dirty ? this.#palette.warning : this.#palette.info,
          ),
        ],
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
      const { icon, tint } = configDomainStyle(candidate, this.#palette);
      const count = modal.catalog.documents.filter(
        (document) => document.domain === candidate,
      ).length;
      const label = titleCaseLabel(candidate);
      if (index === modal.domainIndex)
        return this.#palette.selected(`▸ ${icon} ${label}  ${count}`);
      return `  ${tint(icon)} ${this.#palette.text(label)}  ${this.#palette.dim(String(count))}`;
    });
    const resources = documents.map((document, index) => {
      const connector = index === documents.length - 1 ? "└─" : "├─";
      const readOnly = !document.capabilities.update;
      if (index === modal.documentIndex) {
        return this.#palette.selected(
          `▸ ${connector} ${document.title}${readOnly ? " read only" : ""}`,
        );
      }
      const lock = readOnly ? ` ${this.#palette.dim("read only")}` : "";
      return `  ${this.#palette.dim(connector)} ${this.#palette.text(document.title)}${lock}`;
    });
    if (resources.length === 0) resources.push(this.#palette.muted("No resources in this domain."));

    const editor: string[] = [];
    let editorFocusLine = 0;
    if (!modal.catalog.valid) {
      editor.push(
        this.#palette.warning("Configuration needs repair; edit the exact source below."),
      );
      editor.push(
        ...modal.catalog.diagnostics
          .slice(0, 4)
          .flatMap((diagnostic) =>
            wrapStyled(diagnostic, Math.max(1, layout.editor.width - 2), this.#palette.warning),
          ),
        "",
      );
    }
    if (selected === undefined || modal.source === undefined) {
      editor.push(this.#palette.muted("Select a resource to inspect its project-authored source."));
    } else {
      editor.push(
        sectionHeading(selected.title, this.#palette),
        `${this.#palette.muted(titleCaseLabel(selected.kind))} · ${selected.format.toUpperCase()} · ${formatBytes(selected.sizeBytes)}`,
      );
      if (selected.capabilities.reason !== undefined)
        editor.push(this.#palette.muted(selected.capabilities.reason));
      editor.push("");
      const source = modal.editing ? insertCaret(modal.draft, modal.cursor) : modal.draft;
      const sourceLines = source.split("\n");
      const numberWidth = Math.max(2, String(sourceLines.length).length);
      sourceLines.forEach((line, index) => {
        const prefix = `${String(index + 1).padStart(numberWidth)} │ `;
        const wrapped = wrapTextWithAnsi(
          line.length === 0 ? " " : line,
          Math.max(1, layout.editor.width - prefix.length - 2),
        );
        wrapped.forEach((part, partIndex) => {
          if (part.includes("▌")) editorFocusLine = editor.length;
          editor.push(
            `${this.#palette.muted(partIndex === 0 ? prefix : " ".repeat(prefix.length))}${modal.editing ? this.#palette.text(part) : part}`,
          );
        });
      });
    }

    const dirtyCopy = modal.dirty ? "Raw source · unpublished changes" : "Raw source · current";
    const content = [
      ...this.#header(layout.width, "PROJECT RESOURCES"),
      ...joinColumns(
        [
          panel(
            "Domains",
            domains,
            layout.domains.width,
            layout.domains.height,
            modal.focus === "domains",
            this.#palette,
          ),
          panel(
            titleCaseLabel(domain),
            resources,
            layout.resources.width,
            layout.resources.height,
            modal.focus === "documents",
            this.#palette,
            visibleOffset(0, modal.documentIndex, Math.max(1, layout.resources.height - 2)),
          ),
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
        ],
        [layout.domains.width, layout.resources.width, layout.editor.width],
        layout.domains.height,
      ),
      ...panel(
        dirtyCopy,
        [
          centerLine(
            modal.dirty
              ? "[Ctrl-S] Validate & save   [Ctrl-D] Discard   Esc stays here"
              : "[Enter] Edit   [a] New   [e] Rename   [x] Delete   [t] Run type   [l] Legacy migration   [Esc] Guided",
            Math.max(1, layout.width - 2),
            modal.dirty ? this.#palette.warning : this.#palette.accent,
          ),
        ],
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
    const message =
      this.#snapshot.busy === undefined
        ? this.#snapshot.notice?.message
        : `⚙ ${this.#snapshot.busy}`;
    const cockpitIssue =
      this.#snapshot.cockpitIssue === undefined ? undefined : "view config unavailable";
    const status = message ?? cockpitIssue ?? footerHelp(width);
    const styled =
      this.#snapshot.notice?.kind === "error"
        ? this.#palette.error(status)
        : message === undefined && cockpitIssue !== undefined
          ? this.#palette.warning(status)
          : this.#snapshot.busy === undefined
            ? this.#palette.muted(status)
            : this.#palette.accent(status);
    return [padLine(styled, width)];
  }

  #runsPanel(width: number, height: number): string[] {
    const page = this.#snapshot.view.runPage;
    const hiddenAbove = page.startIndex;
    const hiddenBelow = page.totalRuns - page.startIndex - page.visibleRuns;
    const pageTitle =
      page.totalRuns > page.visibleRuns
        ? `Runs ${page.startIndex + 1}–${page.startIndex + page.visibleRuns} of ${page.totalRuns}${
            hiddenAbove > 0 ? ` · ↑${hiddenAbove} more` : ""
          }${hiddenBelow > 0 ? ` · ↓${hiddenBelow} more` : ""}`
        : "Runs";
    const innerWidth = Math.max(1, width - 2);
    const activeTab = this.#snapshot.view.runTabs.find(
      (tab) => tab.id === this.#snapshot.view.runTab,
    );
    const lines: string[] = [
      centerLine(
        `‹ ${activeTab?.title ?? "All"} ${activeTab?.count ?? 0} ›`,
        innerWidth,
        this.#palette.accent,
      ),
    ];
    let selectedLine = 0;
    for (const row of this.#snapshot.view.runs) {
      const selected = row.id === this.#snapshot.selection.runId;
      if (selected) selectedLine = lines.length;
      const marker =
        row.provisional || row.activeAgentCount > 0
          ? this.#animatedCog()
          : row.paused
            ? "Ⅱ"
            : row.mergeReady
              ? "◆"
              : "●";
      // The right slot surfaces only what needs the operator now: a pause still draining
      // (or scheduled for the next pausable boundary), the settled pause, or a plan review.
      const rightStatus =
        row.pausePending || row.phase === "pausing"
          ? this.#palette.warning("pausing…")
          : row.paused
            ? this.#palette.warning("paused")
            : row.awaitingApproval
              ? this.#palette.warning("[v] review")
              : "";
      const primary = overlayRight(
        `${selected ? "›" : " "} ${statusStyle(marker, row.state, this.#palette)} ${row.title}`,
        rightStatus,
        innerWidth,
      );
      const detail = [
        row.targetBranch,
        this.#palette.chip(row.stage, stageTone(row.phase)),
        row.runType,
        row.newTokens,
      ].join(this.#palette.muted(" · "));
      lines.push(selected ? this.#palette.selected(primary) : primary);
      lines.push(`    ${detail}`);
    }
    if (this.#snapshot.view.runs.length === 0) {
      const total = this.#snapshot.view.runTabs.find((tab) => tab.id === "all")?.count ?? 0;
      if (total > 0) {
        lines.push(
          this.#palette.muted(`No ${(activeTab?.title ?? "matching").toLowerCase()} runs.`),
          this.#palette.dim(`${total} in other tabs · [←→] switch`),
        );
      } else {
        lines.push(
          this.#palette.muted("No runs"),
          this.#palette.dim("Start a run from Koni's New Run flow."),
          this.#palette.accent("[n] New run"),
        );
      }
    }
    return panel(
      pageTitle,
      lines,
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
      centerLine(
        `‹ ${activeTab?.title ?? "All"} ${activeTab?.count ?? 0} ›`,
        Math.max(1, width - 2),
        this.#palette.accent,
      ),
    ];
    let selectedLine = 0;
    const cursorId = this.#snapshot.cursor.ticketId ?? this.#snapshot.selection.ticketId;
    for (const ticket of tickets) {
      const onCursor = ticket.id === cursorId;
      const committed = ticket.id === this.#snapshot.selection.ticketId;
      if (onCursor) selectedLine = lines.length;
      const marker = ticket.proposalAwaitingDecision
        ? "◆"
        : ticket.recovery
          ? "!"
          : ticket.active
            ? "⚙"
            : ticket.status === "Completed"
              ? "●"
              : "○";
      const caret = onCursor ? "›" : committed ? this.#palette.accent("▸") : " ";
      const line = `${caret} ${statusStyle(marker, ticket.status, this.#palette)} ${ticket.title}`;
      lines.push(onCursor ? this.#palette.selected(line) : line);
      const details = [
        ...(!customColumns || configuredColumns.has("operation") ? [ticket.status] : []),
        ...(!customColumns || configuredColumns.has("steps")
          ? [`${ticket.rail} ${ticket.progress}`]
          : []),
        ...((!customColumns || configuredColumns.has("agents")) &&
        ticket.currentPersona !== undefined
          ? [this.#palette.info(ticket.currentPersona)]
          : []),
        ...(ticket.recovery ? [this.#palette.error("recovery needed")] : []),
        ...(ticket.proposalAwaitingDecision
          ? [this.#palette.warning("decision needed · Enter/p inspect")]
          : []),
      ];
      lines.push(`    ${details.join(this.#palette.muted(" · "))}`);
    }
    if (tickets.length === 0)
      lines.push(
        this.#palette.muted(`No ${(activeTab?.title ?? "visible").toLowerCase()} tickets.`),
      );
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
    const tab = this.#snapshot.selection.detailsTab;
    // Stale card targets from a previous frame must never survive a run/tab change.
    this.#graphFeedTicketLines = [];
    const capacity = Math.max(1, height - 3);
    const lines =
      run === undefined
        ? [this.#palette.muted("Select or start a run to inspect its work.")]
        : tab === "graph"
          ? this.#graphFeedTab(run, innerWidth, capacity)
          : this.#detailsLines(run, innerWidth);
    const footer =
      tab === "chat"
        ? completeFooter(
            [
              "[Ctrl-O] tool results · [/] history · [s] compose · [Esc] back",
              "[Ctrl-O] tools · [/] history · [Esc] back",
              "[Esc] back",
            ],
            innerWidth,
          )
        : tab === "graph"
          ? completeFooter(
              [
                "[←→] graph/tickets · [↑↓] cursor · [Enter] open · [[/]] tabs",
                "[←→] columns · [Enter] open",
                "[Enter] open",
              ],
              innerWidth,
            )
          : this.#snapshot.selection.ticketId !== undefined
            ? completeFooter(["[Enter] stage action"], innerWidth)
            : tab === "plan"
              ? completeFooter(["[[/]] tabs"], innerWidth)
              : completeFooter(
                  [
                    "[Ctrl-O] objective · [[/]] tabs · [Enter] stage action",
                    "[Ctrl-O] objective · [[/]] tabs",
                    "[Ctrl-O] objective",
                  ],
                  innerWidth,
                );
    // The open chat is bottom-anchored: scroll.details counts up from the newest line.
    // The graph feed scrolls its two columns internally, so the panel never re-scrolls it.
    const scroll =
      tab === "chat"
        ? Math.max(0, lines.length - capacity - this.#snapshot.scroll.details)
        : tab === "graph"
          ? 0
          : this.#snapshot.scroll.details;
    return panelWithFooter(
      title,
      lines,
      footer,
      width,
      height,
      this.#snapshot.focus === "details",
      this.#palette,
      scroll,
    );
  }

  /** Ticket-card rows in the Graph feed are clickable: a click commits the ticket. */
  #annotateGraphFeedHitTargets(frame: CellGrid, layout: OperateLayout): void {
    if (this.#snapshot.selection.detailsTab !== "graph") return;
    if (this.#graphFeedTicketLines.length === 0) return;
    const inner = Math.max(1, layout.details.width - 2);
    const columns = feedLayout(inner);
    if (columns.stacked) return;
    const xStart = layout.details.x + 1 + columns.graphW + columns.gutterW;
    for (const entry of this.#graphFeedTicketLines) {
      frame.addHitTarget(`ticket:${entry.id}`, {
        x: xStart,
        // +1 for the panel border, +1 for the feed's configured header line.
        y: layout.details.y + 2 + entry.row,
        width: columns.ticketsW,
        height: 1,
      });
    }
  }

  /** The Graph tab body: a configured header line above the live feed compositor. */
  #graphFeedTab(
    run: NonNullable<ControlCenterViewModel["selectedRun"]>,
    innerWidth: number,
    capacity: number,
  ): string[] {
    const configured = cockpitView(this.#snapshot.view.cockpit, ["typed_tree", "graph"]);
    const scope =
      configured?.source.kind === "graph" && configured.source.scope === "main_checkout"
        ? "main checkout"
        : run.graph.scope;
    const header = this.#palette.muted(
      truncateToWidth(`${configured?.title ?? "Graph"} · ${scope}`, innerWidth, "…"),
    );
    const focused = this.#snapshot.focus === "details";
    const feed = renderGraphFeed({
      nodes: run.graph.nodes,
      edges: run.graph.edges,
      feed: run.graphFeed,
      width: innerWidth,
      height: Math.max(1, capacity - 1),
      palette: this.#palette,
      graphOptions: configuredGraphOptions(configured),
      ...(focused
        ? {
            focus: {
              column: this.#snapshot.cursor.graphFeed.column,
              nodeIndex: this.#snapshot.cursor.graphIndex,
              ...(this.#snapshot.cursor.graphFeed.ticketId === undefined
                ? {}
                : { ticketId: this.#snapshot.cursor.graphFeed.ticketId }),
            },
          }
        : {}),
      ...(this.#snapshot.selection.ticketId === undefined
        ? {}
        : { selectedTicketId: this.#snapshot.selection.ticketId }),
      scroll: {
        graph: this.#snapshot.scroll.graph,
        tickets: this.#snapshot.scroll.feedTickets,
      },
      animationFrame: this.#animationFrame,
    });
    this.#graphFeedTicketLines = feed.ticketLines;
    return [header, ...feed.lines];
  }

  #detailsLines(run: NonNullable<ControlCenterViewModel["selectedRun"]>, width: number): string[] {
    switch (this.#snapshot.selection.detailsTab) {
      case "graph": {
        // The Graph tab is composed by #graphFeedTab before #detailsLines is consulted.
        return [];
      }
      case "overview": {
        const lines: string[] = [];
        if (run.blockedBanner !== undefined) {
          lines.push(
            this.#palette.bold(this.#palette.error("Run blocked")),
            ...wrapStyled(run.blockedBanner.reason, width, this.#palette.error),
          );
          for (const action of run.blockedBanner.actions) {
            lines.push(
              ...wrapStyled(
                `• ${action.title} — ${action.reason}`,
                width,
                action.available ? this.#palette.accent : this.#palette.muted,
              ),
            );
          }
          lines.push(this.#palette.dim("[a] all actions"), "");
        }
        if (run.ticketDetails !== undefined) {
          // A committed ticket owns the overview: its title renders once as the heading and
          // the run-level sections stay out of the way (Enter on the run row restores them).
          lines.push(
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
            const marker = complete
              ? this.#palette.success("●")
              : step.status === "Running"
                ? this.#palette.accent("⚙")
                : step.status === "Failed"
                  ? this.#palette.error("●")
                  : this.#palette.muted("○");
            const state = complete ? "" : ` · ${step.status}`;
            lines.push(`${marker} ${step.title} · ${this.#palette.muted(step.persona)}${state}`);
            const metadata = [
              `${step.attemptCount} ${step.attemptCount === 1 ? "attempt" : "attempts"}`,
              ...(step.dependsOn.length === 0 ? [] : [`after ${step.dependsOn.join(" · ")}`]),
              ...(step.validation === undefined ? [] : [`must satisfy ${step.validation}`]),
            ];
            lines.push(`  ${this.#palette.muted(metadata.join(" · "))}`);
            if (step.summary !== undefined) {
              lines.push(
                `  ${complete ? this.#palette.success(step.summary) : this.#palette.text(step.summary)}`,
              );
            } else if (complete) {
              lines.push(`  ${this.#palette.muted("No outcome summary recorded")}`);
            }
          }
          if (
            run.ticketDetails.interactsWith.length > 0 ||
            run.ticketDetails.unresolvedNodeCount > 0
          ) {
            const outside =
              run.ticketDetails.unresolvedNodeCount > 0
                ? `${run.ticketDetails.interactsWith.length > 0 ? " · " : ""}${run.ticketDetails.unresolvedNodeCount} more outside this view`
                : "";
            lines.push(
              "",
              ...wrapStyled(
                `Interacts with: ${run.ticketDetails.interactsWith.join(" · ")}${outside}`,
                width,
                this.#palette.text,
              ),
            );
          }
          if (run.ticketDetails.mustSatisfy.length > 0) {
            lines.push(
              ...wrapStyled(
                `Must satisfy: ${run.ticketDetails.mustSatisfy.join(" · ")}`,
                width,
                this.#palette.text,
              ),
            );
          }
          if (run.ticketDetails.policy !== undefined) {
            lines.push(
              ...wrapStyled(`Policy: ${run.ticketDetails.policy}`, width, this.#palette.muted),
            );
          }
          return lines;
        }
        const renderedObjective = wrapTextWithAnsi(run.objective.text, width);
        const objective = run.objective.expanded
          ? renderedObjective
          : renderedObjective.slice(0, 4);
        lines.push(
          sectionHeading("Objective", this.#palette),
          ...objective.map((line) => this.#palette.text(line)),
          this.#palette.dim(
            run.objective.expanded ? "[Ctrl-O] collapse objective" : "[Ctrl-O] full objective",
          ),
        );
        lines.push("", sectionHeading("Run", this.#palette), ...this.#runVitalLines(run, width));
        for (const section of run.overviewSections) {
          // Run vitals render as structured components above; the plain lines remain the
          // view-model contract for tests and non-visual consumers.
          if (section.title === "Run") continue;
          lines.push("", sectionHeading(section.title, this.#palette));
          lines.push(...this.#evidenceLines(section, width));
        }
        lines.push("", this.#stagesHeading(run), ...this.#stageLines(run, width));
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
      case "chat": {
        const agent = run.agents.find(
          (candidate) => candidate.id === this.#snapshot.selection.attemptId,
        );
        if (agent === undefined)
          return [this.#palette.muted("Select an agent to inspect its session.")];
        const lines: string[] = [
          ...(agent.active ? [] : [this.#palette.muted("Historical session · read-only")]),
        ];
        const chat = this.#snapshot.chat;
        if (chat === undefined || chat.status === "loading")
          lines.push("", this.#palette.accent("⚙ Loading Pi session…"));
        else if (chat.status === "unavailable")
          lines.push(
            "",
            this.#palette.muted("This authority does not expose persisted Pi transcripts."),
          );
        else if (chat.status === "error")
          lines.push("", this.#palette.error(chat.error ?? "Pi transcript could not be loaded."));
        else {
          // Model/reasoning changes already live in the panel title; session bookkeeping
          // notices are metadata, not conversation.
          const visible = chat.blocks.filter(
            (block) =>
              !(block.kind === "notice" && HEADER_NOTICE_TITLES.has(block.title)) &&
              (chat.toolsVisible || (block.kind !== "tool_call" && block.kind !== "tool_result")),
          );
          const hiddenTools = chat.toolsVisible
            ? 0
            : chat.blocks.filter(
                (block) => block.kind === "tool_call" || block.kind === "tool_result",
              ).length;
          if (chat.history.hasOlder) {
            lines.push(
              "",
              this.#palette.dim("Older history available · [ loads the previous window"),
            );
          }
          if (hiddenTools > 0) {
            lines.push(
              "",
              this.#palette.dim(
                `${hiddenTools} tool event${hiddenTools === 1 ? "" : "s"} hidden · [Ctrl-O] show`,
              ),
            );
          }
          for (const block of visible) {
            const chunk =
              block.chunk === undefined ? "" : ` · part ${block.chunk.index}/${block.chunk.total}`;
            lines.push(
              "",
              ...surfaceBlock(
                [
                  transcriptHeading(
                    block.kind,
                    `${block.branch ? "↳ " : ""}${block.title}${chunk}`,
                    this.#palette,
                  ),
                  ...renderKoniMarkdown(block.markdown, Math.max(1, width - 2), this.#palette).map(
                    (line) => ` ${line}`,
                  ),
                ],
                width,
                this.#palette,
              ),
            );
          }
          for (const diagnostic of chat.diagnostics)
            lines.push("", this.#palette.warning(diagnostic));
        }
        if (chat !== undefined && agent.active) {
          lines.push(
            "",
            sectionHeading("Message", this.#palette),
            `${selectorBadge(chat.draft.mode === "steer" ? "Steer now" : "Follow up", chat.draft.editing, this.#palette)} ${this.#palette.muted("[Tab] mode")}`,
          );
          const value =
            chat.draft.text.length === 0
              ? this.#palette.dim("Write steering or a follow-up…")
              : chat.draft.text;
          lines.push(
            ...wrapStyled(`${chat.draft.editing ? "▌ " : "  "}${value}`, width, (line) => line),
          );
          lines.push(
            this.#palette.dim(
              chat.draft.editing
                ? "[Ctrl-Enter] send · [Alt/Shift-Enter] newline · [Esc] finish"
                : "[Enter/s] compose",
            ),
          );
        }
        return lines;
      }
    }
  }

  /** Structured Run vitals: labeled chips, meters, and counters instead of plain key/value text. */
  #runVitalLines(run: NonNullable<ControlCenterViewModel["selectedRun"]>, width: number): string[] {
    const stats = run.stats;
    const label = (text: string): string => this.#palette.muted(text.padEnd(9));
    const rows: string[] = [
      `${label("Status")}${this.#palette.chip(stats.statusLabel, stageTone(stats.phase))}`,
      `${label("Target")}${this.#palette.accent(`⎇ ${stats.targetBranch}`)}`,
      `${label("Tickets")}${meterBar(stats.tickets.completed, stats.tickets.total, this.#palette)} ${this.#palette.text(
        `${stats.tickets.completed}/${stats.tickets.total}`,
      )}${stats.questionCount > 0 ? ` ${this.#palette.warning(`· ${stats.questionCount} question${stats.questionCount === 1 ? "" : "s"} pending`)}` : ""}`,
      `${label("Agents")}${
        stats.agents.active > 0
          ? `${this.#animatedCog()} ${this.#palette.text(`${stats.agents.active} active`)} ${this.#palette.muted(
              `of ${stats.agents.total}`,
            )}`
          : this.#palette.muted(
              stats.agents.total === 0 ? "none yet" : `${stats.agents.total} concluded`,
            )
      }`,
      `${label("Tokens")}${this.#palette.text(`${formatTokens(stats.tokens.fresh)} fresh`)} ${this.#palette.muted(
        `· ${formatTokens(stats.tokens.total)} provider total`,
      )}`,
      `${label("Cache")}${meterBar(stats.tokens.cached, stats.tokens.total, this.#palette)} ${this.#palette.muted(
        `${stats.tokens.total === 0 ? 0 : Math.round((stats.tokens.cached / stats.tokens.total) * 100)}% cached input/write`,
      )}`,
    ];
    if (stats.uncertainExposure > 0) {
      rows.push(
        `${label("Exposure")}${this.#palette.warning(
          `≤${formatTokens(stats.uncertainExposure)} retired by operator`,
        )}`,
      );
    }
    if (stats.selectedTicket !== undefined) {
      rows.push(
        `${label("Ticket")}${this.#palette.text(
          truncateToWidth(stats.selectedTicket.title, Math.max(1, width - 20), "…"),
        )} ${this.#palette.muted(`· ${stats.selectedTicket.status}`)}`,
      );
    }
    return rows.map((row) => truncateToWidth(row, width, "…", true));
  }

  /** Evidence keeps its exact operator copy but each line leads with a tone glyph. */
  #evidenceLines(
    section: NonNullable<ControlCenterViewModel["selectedRun"]>["overviewSections"][number],
    width: number,
  ): string[] {
    const style =
      section.tone === "error"
        ? this.#palette.error
        : section.tone === "success"
          ? this.#palette.success
          : this.#palette.text;
    const glyph =
      section.tone === "error"
        ? this.#palette.error("!")
        : section.tone === "success"
          ? this.#palette.success("✓")
          : this.#palette.muted("○");
    return section.lines.flatMap((value, index) =>
      index === 0
        ? wrapStyled(value, Math.max(1, width - 2), (line) =>
            section.tone === undefined ? style(line) : this.#palette.bold(style(line)),
          ).map((line, part) => (part === 0 ? `${glyph} ${line}` : `  ${line}`))
        : wrapStyled(value, Math.max(1, width - 2), style).map((line, part) =>
            part === 0 ? `${this.#palette.dim("•")} ${line}` : `  ${line}`,
          ),
    );
  }

  /** Stage progress at a glance: the section heading carries a dot rail and a counter. */
  #stagesHeading(run: NonNullable<ControlCenterViewModel["selectedRun"]>): string {
    const done = run.stages.filter((stage) => stage.state === "done").length;
    const rail = run.stages
      .map((stage) =>
        stage.state === "done"
          ? this.#palette.success("●")
          : stage.state === "active"
            ? this.#palette.accent(run.spendingTokens ? "◉" : "◐")
            : this.#palette.dim("○"),
      )
      .join("");
    return `${sectionHeading("Stages", this.#palette)}  ${rail}  ${this.#palette.muted(
      `${done}/${run.stages.length}`,
    )}`;
  }

  #stageLines(run: NonNullable<ControlCenterViewModel["selectedRun"]>, width: number): string[] {
    return run.stages.flatMap((stage, index) => {
      const marker =
        stage.state === "done"
          ? this.#palette.success("●")
          : stage.state === "active" && run.spendingTokens
            ? this.#palette.accent(this.#animatedCog())
            : stage.state === "active"
              ? this.#palette.accent("◐")
              : this.#palette.muted("○");
      const available = stage.actions.filter((action) => action.available);
      const disabled = stage.actions.filter((action) => !action.available);
      return [
        ...wrapStyled(`${marker} ${index + 1}. ${stage.title}`, width, (value) => value),
        ...(stage.state === "active"
          ? [
              this.#palette.muted(
                `   ${stage.category ?? "Current stage"} · ${stage.interaction?.mode ?? "automatic"}`,
              ),
            ]
          : []),
        ...(stage.summary === undefined
          ? []
          : wrapStyled(
              stage.summary,
              Math.max(1, width - 3),
              (value) => `   ${this.#palette.warning(value)}`,
            )),
        ...available.flatMap((action) =>
          wrapStyled(`   [Enter] ${action.title} · ${action.reason}`, width, this.#palette.accent),
        ),
        ...(stage.state !== "active" || disabled.length === 0
          ? []
          : disabled.flatMap((action) =>
              wrapStyled(
                `   ${action.title} unavailable · ${action.reason}`,
                width,
                this.#palette.muted,
              ),
            )),
      ];
    });
  }

  #questionsPanel(width: number, height: number): string[] {
    const questions = this.#snapshot.view.selectedRun?.questions ?? [];
    const question = questions[this.#snapshot.questionIndex];
    if (question === undefined) {
      return panel(
        "Questions",
        [this.#palette.muted("No questions pending.")],
        width,
        height,
        this.#snapshot.focus === "questions",
        this.#palette,
      );
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
      const recommended =
        question.recommendationOptionId === option.id ? ` ${this.#palette.warning("★")}` : "";
      const row = `${selected ? "●" : "○"} ${option.label}${recommended}`;
      lines.push(selected ? this.#palette.selected(row) : row);
      lines.push(
        ...wrapStyled(
          option.description,
          Math.max(1, inner - 3),
          (value) => `   ${this.#palette.muted(value)}`,
        ),
      );
    }
    const noneSelected = draft?.selectedOptionId === undefined;
    if (noneSelected) selectedLine = lines.length;
    lines.push(
      noneSelected ? this.#palette.selected("● None of the above") : "○ None of the above",
    );
    if (question.allowsNotes) {
      lines.push("", centeredDivider("Notes (optional)", inner, this.#palette));
      const notes = draft?.notes ?? "";
      const noteText = notes.length === 0 ? this.#palette.dim("Add context to any answer…") : notes;
      lines.push(
        ...wrapStyled(`${draft?.editingNotes === true ? "▌ " : "  "}${noteText}`, inner, (value) =>
          draft?.editingNotes === true ? this.#palette.selected(value) : value,
        ),
      );
    }
    if (question.answerSaved)
      lines.push("", this.#palette.success("Saved · submit again to revise"));
    return panelWithFooter(
      "Questions",
      lines,
      completeFooter(
        question.allowsNotes
          ? ["←→/[] · ↑↓/jk · Enter · [n] notes", "←→/[] ↑↓/jk Enter", "Enter"]
          : ["←→/[] · ↑↓/jk · Enter", "←→/[] ↑↓/jk Enter", "Enter"],
        Math.max(1, width - 2),
      ),
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
    const cursorId = this.#snapshot.cursor.attemptId ?? this.#snapshot.selection.attemptId;
    for (const agent of agents) {
      const onCursor = agent.id === cursorId;
      const openChat = agent.id === this.#snapshot.selection.attemptId;
      if (onCursor) selectedLine = lines.length;
      const marker = agent.active ? this.#palette.accent("⚙") : "●";
      // Lineage renders as nesting: children indent under the attempt they branched from.
      const indent = `${"  ".repeat(agent.depth)}${agent.depth > 0 ? "└ " : ""}`;
      const caret = onCursor ? "›" : openChat ? this.#palette.accent("▸") : " ";
      const row = `${caret} ${indent}${marker} ${agent.label} · ${this.#palette.muted(agent.work)}`;
      lines.push(
        onCursor ? this.#palette.selected(row) : agent.active ? row : this.#palette.muted(row),
      );
      const leaf = agent.lineage?.activeLeaf === true ? ` · ${this.#palette.success("leaf")}` : "";
      const planning =
        agent.planning === undefined
          ? ""
          : ` · Revision ${agent.planning.currentRevision} · ${formatTokens(agent.planning.revisionUsage.new)} revision new / ${formatTokens(agent.planning.cumulativeUsage.new)} cumulative new`;
      const detail = `    ${indent}${modelStyle(agent.model, this.#palette)} · ${thinkingStyle(agent.thinking, this.#palette)} · ${agent.newTokens} new${planning}${leaf}`;
      lines.push(agent.active ? detail : this.#palette.dim(detail));
    }
    if (lines.length === 0) lines.push(this.#palette.muted("No agent attempts yet."));
    return panel(
      configured?.title ?? "Agents",
      lines,
      width,
      height,
      this.#snapshot.focus === "agents",
      this.#palette,
      visibleOffset(this.#snapshot.scroll.agents, selectedLine, height - 2),
    );
  }

  #activityPanel(width: number, height: number): string[] {
    const run = this.#snapshot.view.selectedRun;
    const configured = cockpitView(this.#snapshot.view.cockpit, ["summary"]);
    const title = recentActivityTitle(
      run?.activeDuration,
      Math.max(1, width - 2),
      configured?.title,
    );
    // Every retained event renders; the panel scroll is the operator's window into history.
    const lines =
      run?.activity.flatMap((activity) =>
        wrapStyled(
          `${this.#palette.muted(activity.timestamp)}  ${activityStyle(activity.kind, activity.message, this.#palette, activity.tone)}`,
          Math.max(1, width - 2),
          (value) => value,
        ),
      ) ?? [];
    if (lines.length === 0) lines.push(this.#palette.muted("No activity recorded."));
    return panel(
      title,
      lines,
      width,
      height,
      this.#snapshot.focus === "activity",
      this.#palette,
      this.#snapshot.scroll.activity,
    );
  }

  #renderModal(width: number, height: number): string[] {
    const modal = this.#snapshot.modal!;
    if (modal.kind === "graph_node") return this.#renderGraphNode(modal, width, height);
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
    if (modal.kind === "config_document_create")
      return this.#renderConfigDocumentCreate(modal, width, height);
    if (modal.kind === "config_document_rename")
      return this.#renderConfigDocumentRename(modal, width, height);
    if (modal.kind === "config_document_delete")
      return this.#renderConfigDocumentDelete(modal, width, height);
    if (modal.kind === "config_run_type_wizard")
      return this.#renderConfigRunTypeWizard(modal, width, height);
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
    if (modal.kind === "profile_conflicts")
      return this.#renderProfileConflicts(modal, width, height);
    return this.#renderHelp(modal.topic, modal.scroll, width, height);
  }

  /**
   * Contextual help is the documentation operators actually read: what the surface is, how it
   * fits the run pipeline (with the same text diagrams the repository docs use), why it behaves
   * the way it does, and only then the key list.
   */
  #renderHelp(
    topic: ControlCenterHelpTopic,
    scroll: number,
    width: number,
    height: number,
  ): string[] {
    const help = HELP[topic];
    const inner = Math.max(1, width - 2);
    const lines: string[] = [...wrapStyled(help.description, inner, this.#palette.text)];
    if (help.diagram !== undefined && help.diagram.length > 0) {
      lines.push("", centeredDivider("How it fits", inner, this.#palette));
      lines.push(
        ...help.diagram.map((row) =>
          truncateToWidth(` ${this.#palette.info(row)}`, inner, "…", true),
        ),
      );
    }
    lines.push("", centeredDivider("In the workflow", inner, this.#palette));
    lines.push(...wrapStyled(helpWorkflow(topic), inner, this.#palette.muted));
    if (help.philosophy !== undefined && help.philosophy.length > 0) {
      lines.push("", centeredDivider("Why it works this way", inner, this.#palette));
      help.philosophy.forEach((paragraph, index) => {
        if (index > 0) lines.push("");
        lines.push(...wrapStyled(paragraph, inner, this.#palette.text));
      });
    }
    lines.push("", centeredDivider("Available here", inner, this.#palette));
    lines.push(
      ...help.actions.map(
        ([keys, meaning]) => `${this.#palette.accent(keys.padEnd(16))}${meaning}`,
      ),
    );
    return panelWithFooter(
      `Help · ${help.title}`,
      lines,
      "↑↓ scroll · [h/F1/Esc/Enter/q] close",
      width,
      Math.min(height, lines.length + 3),
      true,
      this.#palette,
      scroll,
    );
  }

  /** Enter on a graph node: its complete title, status, authored facts, and relationships. */
  #renderGraphNode(modal: GraphNodeModalState, width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const graph = this.#snapshot.view.selectedRun?.graph;
    const node = graph?.nodes.find((candidate) => candidate.id === modal.nodeId);
    if (graph === undefined || node === undefined) {
      return panel(
        "Graph node",
        [
          this.#palette.muted("This node is no longer part of the selected graph view."),
          "",
          this.#palette.dim("[Esc] close"),
        ],
        width,
        Math.min(height, 7),
        true,
        this.#palette,
      );
    }
    const label = (text: string): string => this.#palette.muted(text.padEnd(9));
    const lines: string[] = [
      ...wrapStyled(node.fullTitle, inner, (line) => this.#palette.bold(this.#palette.text(line))),
      "",
      `${label("Type")}${this.#palette.bold(
        graphNodeStyle(node.type, `[${node.type.replace(/_/gu, "-")}]`, this.#palette),
      )}`,
      `${label("Status")}${
        node.status === undefined
          ? this.#palette.muted("unknown")
          : this.#palette.chip(titleCaseLabel(node.status), node.muted ? "muted" : "success")
      }`,
    ];
    if (node.facts !== undefined && node.facts.length > 0) {
      lines.push("", centeredDivider("Authored facts", inner, this.#palette));
      for (const fact of node.facts) {
        const factLabel = truncateToWidth(fact.label, 14, "…");
        const valueWidth = Math.max(1, inner - 16);
        const wrapped = wrapTextWithAnsi(fact.value, valueWidth);
        wrapped.forEach((line, index) => {
          lines.push(
            index === 0
              ? `${this.#palette.muted(factLabel.padEnd(15))} ${this.#palette.text(line)}`
              : `${" ".repeat(16)}${this.#palette.text(line)}`,
          );
        });
      }
    }
    const titleById = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]));
    const relationRow = (direction: "→" | "←", relation: string, otherId: string): string => {
      const other = titleById.get(otherId);
      const otherLabel =
        other === undefined
          ? this.#palette.dim("outside this view")
          : `${this.#palette.bold(graphNodeStyle(other.type, graphBadge(other.type, 20), this.#palette))} ${
              other.muted ? this.#palette.dim(other.label) : this.#palette.text(other.label)
            }`;
      return truncateToWidth(
        `${this.#palette.accent(direction)} ${this.#palette.info(
          formatGraphRelation(relation).padEnd(14),
        )} ${otherLabel}`,
        inner,
        "…",
        true,
      );
    };
    const outgoing = graph.edges.filter((edge) => edge.source === node.id);
    const incoming = graph.edges.filter((edge) => edge.target === node.id);
    lines.push("", centeredDivider("Relationships", inner, this.#palette));
    if (outgoing.length === 0 && incoming.length === 0) {
      lines.push(this.#palette.muted("No relationships in this view."));
    } else {
      for (const edge of outgoing) lines.push(relationRow("→", edge.relation, edge.target));
      for (const edge of incoming) lines.push(relationRow("←", edge.relation, edge.source));
    }
    return panelWithFooter(
      `Graph node · ${node.type.replace(/_/gu, "-")}`,
      lines,
      "↑↓ scroll · Enter/Esc close · h help",
      width,
      Math.min(height, lines.length + 3),
      true,
      this.#palette,
      modal.scroll,
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
      this.#palette.error(
        "Deletion first tombstones this run and stops every associated Pi session.",
      ),
      this.#palette.muted(
        "Koni then retires its owned Git resources. The target branch is never deleted.",
      ),
    ];
    if (modal.blockers.length > 0) {
      lines.push("", sectionHeading("Current blockers", this.#palette));
      lines.push(
        ...modal.blockers.flatMap((blocker) =>
          wrapStyled(`• ${blocker}`, inner, this.#palette.warning),
        ),
      );
    }
    if (modal.dirtyWorktreeWarnings.length > 0) {
      lines.push("", sectionHeading("Preserved work", this.#palette));
      lines.push(
        ...modal.dirtyWorktreeWarnings.flatMap((warning) =>
          wrapStyled(`• ${warning}`, inner, this.#palette.warning),
        ),
      );
    }
    lines.push(
      "",
      centerButtons(
        [
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
        ],
        this.#palette,
      ),
      this.#palette.dim("←→/[] choose · Enter confirm · Esc cancel · h help"),
    );
    return panel(
      "Delete run",
      lines,
      width,
      height,
      true,
      this.#palette,
      visibleOffset(0, lines.length - 2, Math.max(1, height - 2)),
    );
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
      lines.push(
        ...modal.blockers.flatMap((blocker) =>
          wrapStyled(`• ${blocker}`, inner, this.#palette.warning),
        ),
      );
    } else {
      lines.push(
        "",
        this.#palette.success("Compiler preparation is complete."),
        this.#palette.muted(
          "Authorization re-checks the target before publishing the prepared result.",
        ),
      );
    }
    if (modal.targetAdvanced || modal.resyncState !== "current") {
      lines.push(
        "",
        this.#palette.warning(
          modal.resyncState === "required"
            ? "The target advanced; Koni must resynchronize and verify again before promotion."
            : "The current target state is unavailable for authorization.",
        ),
      );
    }
    lines.push(
      "",
      centerButtons(
        [
          { label: "Cancel", selected: modal.selected === "cancel", tone: "normal" },
          {
            label: "Authorize merge",
            selected: modal.selected === "authorize",
            tone: modal.canAuthorize ? "success" : "disabled",
          },
        ],
        this.#palette,
      ),
      this.#palette.dim("←→/[] choose · Enter authorize · Esc cancel · h help"),
    );
    return panel(
      "Merge run",
      lines,
      width,
      height,
      true,
      this.#palette,
      visibleOffset(0, lines.length - 2, Math.max(1, height - 2)),
    );
  }

  #renderAnswerQuestion(modal: AnswerQuestionModalState, width: number, height: number): string[] {
    const questions = this.#snapshot.view.selectedRun?.questions ?? [];
    const index = Math.max(
      0,
      questions.findIndex((question) => question.id === modal.questionId),
    );
    const question = questions[index];
    if (question === undefined) {
      return panel(
        "Answer question",
        [
          this.#palette.muted("This question is no longer pending."),
          "",
          this.#palette.dim("[Esc] close"),
        ],
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
      const recommended =
        question.recommendationOptionId === option.id
          ? ` ${this.#palette.warning("★ Recommended")}`
          : "";
      const row = `${selected ? "●" : "○"} ${option.label}${recommended}`;
      lines.push(modal.focus === "choices" && selected ? this.#palette.selected(row) : row);
      lines.push(
        ...wrapStyled(
          option.description,
          Math.max(1, inner - 4),
          (value) => `    ${this.#palette.muted(value)}`,
        ),
      );
    }
    const none = draft?.selectedOptionId === undefined;
    if (none) selectedChoiceLine = lines.length;
    const noneRow = `${none ? "●" : "○"} None of the above`;
    lines.push(modal.focus === "choices" && none ? this.#palette.selected(noneRow) : noneRow, "");
    const notesLine = lines.length;
    lines.push(centeredDivider("Notes (optional)", inner, this.#palette));
    const notes = draft?.notes ?? "";
    const noteText = notes.length === 0 ? this.#palette.dim("Add context to any answer…") : notes;
    lines.push(
      ...wrapStyled(`${modal.focus === "notes" ? "▌ " : "  "}${noteText}`, inner, (value) =>
        modal.focus === "notes" ? this.#palette.selected(value) : value,
      ),
    );
    const submitLine = lines.length + 1;
    const submitLabel = question.resolvesBatchOnSubmit
      ? (question.batchQuestionCount ?? 1) === 1
        ? "Submit answer"
        : "Submit all answers"
      : question.answerSaved
        ? "Revise answer"
        : "Save & next";
    lines.push("", centeredButton(submitLabel, modal.focus === "submit", this.#palette));
    lines.push(
      this.#palette.dim(
        "←→/[] question · ↑↓/jk option · Tab focus · Enter select/newline · Ctrl-Enter submit · Esc close",
      ),
    );
    const focusLine =
      modal.focus === "choices"
        ? selectedChoiceLine
        : modal.focus === "notes"
          ? notesLine
          : submitLine;
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
      lines.push(
        selected ? this.#palette.selected(title) : available ? title : this.#palette.muted(title),
      );
      lines.push(
        ...wrapStyled(
          action.description,
          Math.max(1, inner - 4),
          (value) => `    ${available ? this.#palette.text(value) : this.#palette.muted(value)}`,
        ),
      );
      lines.push(
        ...wrapStyled(
          action.availability.reason,
          Math.max(1, inner - 4),
          (value) => `    ${available ? this.#palette.dim(value) : this.#palette.warning(value)}`,
        ),
      );
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
      const value =
        field.locked && field.displayValue !== undefined
          ? field.displayValue
          : actionValueLabel(modal.values[field.key]);
      const lock = field.locked ? ` ${this.#palette.muted("compiler bound")}` : "";
      lines.push(
        `${selected ? this.#palette.accent("›") : " "} ${this.#palette.bold(field.label)}  ${inputBadge(value, selected, this.#palette)}${lock}`,
      );
      if (selected || field.locked) {
        lines.push(
          ...wrapStyled(
            field.description,
            Math.max(1, inner - 4),
            (copy) => `    ${this.#palette.muted(copy)}`,
          ),
        );
      }
      if (selected && modal.editing && !field.locked) {
        const editor = insertCaret(actionValueLabel(modal.values[field.key]), modal.cursor);
        lines.push(
          ...wrapStyled(
            editor,
            Math.max(1, inner - 4),
            (copy) => `    ${this.#palette.selected(copy)}`,
          ),
        );
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
    if (modal.error !== undefined)
      lines.push("", ...wrapStyled(modal.error, inner, this.#palette.error));
    if (modal.focus === "submit") focusLine = lines.length + 1;
    lines.push(
      "",
      centeredButton(
        form?.submitLabel ?? modal.action.title,
        modal.focus === "submit",
        this.#palette,
      ),
      this.#palette.dim(
        "Tab/↑↓ fields · ←→ change · Enter edit/select · Ctrl-Enter apply · Esc close · h help",
      ),
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

  #renderConfigDocumentCreate(
    modal: ConfigDocumentCreateModalState,
    width: number,
    height: number,
  ): string[] {
    const inner = Math.max(1, width - 2);
    const choice = modal.choices[modal.choiceIndex];
    const title =
      modal.focus === "title"
        ? insertCaret(modal.title, modal.cursor)
        : modal.title.length === 0
          ? "Name this resource…"
          : modal.title;
    const lines = [
      centeredDivider("Resource type", inner, this.#palette),
      selectorWindow(
        modal.choices.map((item) => item.label),
        modal.choiceIndex,
        inner,
        this.#palette,
      ),
      ...wrapStyled(choice?.description ?? "", inner, this.#palette.muted),
      "",
      centeredDivider("Title", inner, this.#palette),
      modal.focus === "title"
        ? this.#palette.selected(` ${title}`)
        : ` ${this.#palette.muted(title)}`,
      "",
      centeredButton("Create resource", modal.focus === "submit", this.#palette),
      this.#palette.dim(
        "←→ type/caret · Tab/↑↓ focus · Enter continue/create · Esc cancel · h help",
      ),
    ];
    return panel(
      "New project resource",
      lines,
      width,
      Math.min(height, Math.max(14, lines.length + 2)),
      true,
      this.#palette,
    );
  }

  #renderConfigDocumentRename(
    modal: ConfigDocumentRenameModalState,
    width: number,
    height: number,
  ): string[] {
    const inner = Math.max(1, width - 2);
    const value = modal.focus === "title" ? insertCaret(modal.title, modal.cursor) : modal.title;
    return panel(
      "Rename resource",
      [
        ...wrapStyled(
          "Renaming updates semantic identity and compiler references atomically where the resource kind requires it.",
          inner,
          this.#palette.muted,
        ),
        "",
        centeredDivider("Title", inner, this.#palette),
        modal.focus === "title" ? this.#palette.selected(` ${value}`) : ` ${value}`,
        "",
        centeredButton("Rename resource", modal.focus === "submit", this.#palette),
        this.#palette.dim("←→ caret · Tab focus · Enter continue/rename · Esc cancel · h help"),
      ],
      width,
      Math.min(height, 14),
      true,
      this.#palette,
    );
  }

  #renderConfigDocumentDelete(
    modal: ConfigDocumentDeleteModalState,
    width: number,
    height: number,
  ): string[] {
    const inner = Math.max(1, width - 2);
    const allowed = modal.canDelete;
    const explanation = allowed
      ? "The authority will compile the complete project without this resource before publishing the deletion."
      : (modal.reason ?? "The configuration authority does not allow this resource to be deleted.");
    return panel(
      "Delete project resource",
      [
        sectionHeading(modal.title, this.#palette),
        "",
        ...wrapStyled(explanation, inner, allowed ? this.#palette.warning : this.#palette.error),
        "",
        ...centerButtons(
          [
            { label: "Cancel", selected: modal.selected === "cancel", tone: "normal" },
            {
              label: "Delete resource",
              selected: modal.selected === "delete",
              tone: allowed ? "danger" : "disabled",
            },
          ],
          this.#palette,
        ),
        this.#palette.dim("←→ choose · Enter confirm · Esc cancel · h help"),
      ],
      width,
      Math.min(height, 14),
      true,
      this.#palette,
    );
  }

  #renderConfigRunTypeWizard(
    modal: ConfigRunTypeWizardModalState,
    width: number,
    height: number,
  ): string[] {
    const inner = Math.max(1, width - 2);
    const template = modal.templates.templates[modal.templateIndex];
    const field = (
      label: string,
      value: string,
      focus: ConfigRunTypeWizardModalState["focus"],
    ): string[] => {
      const selected = modal.focus === focus;
      const shown = selected
        ? insertCaret(value, modal.cursor)
        : value.length === 0
          ? "Optional"
          : value;
      return [
        `${selected ? this.#palette.accent("›") : " "} ${this.#palette.bold(label)}  ${inputBadge(shown, selected, this.#palette)}`,
      ];
    };
    const description =
      modal.focus === "description"
        ? insertCaret(modal.description, modal.cursor)
        : modal.description.length === 0
          ? "Describe when this workflow should be used…"
          : modal.description;
    const lines = [
      centeredDivider("Template", inner, this.#palette),
      selectorWindow(
        modal.templates.templates.map((item) => item.title),
        modal.templateIndex,
        inner,
        this.#palette,
      ),
      ...wrapStyled(template?.description ?? "", inner, this.#palette.muted),
      "",
      ...field("Title", modal.title, "title"),
      ...field("Slug", modal.slug, "slug"),
      `${modal.focus === "description" ? this.#palette.accent("›") : " "} ${this.#palette.bold("Description")}`,
      ...wrapStyled(
        description,
        Math.max(1, inner - 3),
        (copy) =>
          `   ${modal.focus === "description" ? this.#palette.selected(copy) : this.#palette.muted(copy)}`,
      ),
      `${modal.makeDefault ? this.#palette.success("●") : this.#palette.muted("○")} Make this the project default`,
      "",
      centeredButton("Create run type", modal.focus === "submit", this.#palette),
      this.#palette.dim(
        "Tab/↑↓ focus · ←→ change · Enter continue/newline · Ctrl-Enter create · Esc cancel",
      ),
    ];
    return panel(
      "New run type",
      lines,
      width,
      height,
      true,
      this.#palette,
      visibleOffset(0, lines.length - 2, Math.max(1, height - 2)),
    );
  }

  #renderEditScalar(modal: EditScalarModalState, width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const withCaret = insertCaret(modal.value, modal.cursor);
    const editor = withCaret
      .split("\n")
      .flatMap((line) => wrapStyled(line.length === 0 ? " " : line, inner, this.#palette.selected));
    const valueRows = Math.max(2, height - 10 - Number(modal.error !== undefined));
    const caretLine = Math.max(
      0,
      editor.findIndex((line) => line.includes("▌")),
    );
    const start = visibleOffset(0, caretLine, valueRows);
    const visible = editor.slice(start, start + valueRows);
    while (visible.length < valueRows) visible.push(this.#palette.selected(" "));
    const submit =
      modal.field.kind === "multiline" || modal.field.kind === "string_list"
        ? "Ctrl-Enter apply"
        : "Enter apply";
    return panel(
      `Edit ${modal.field.label}`,
      [
        ...wrapStyled(modal.field.description, inner, this.#palette.muted),
        `${this.#palette.muted("Type")} ${configKindLabel(modal.field.kind)}`,
        "",
        ...visible,
        ...(modal.error === undefined
          ? []
          : ["", ...wrapStyled(modal.error, inner, this.#palette.error)]),
        "",
        this.#palette.dim(
          `←→ caret · Home/End · Backspace/Delete · ${submit} · Esc cancel · h help`,
        ),
      ],
      width,
      height,
      true,
      this.#palette,
    );
  }

  #newRunTargetLines(modal: NewRunModalState): string[] {
    const lines = [
      selectorLine(
        "Target branch",
        runTargetSelectedLabel(modal.target),
        modal.focus === "branch",
        this.#palette,
      ),
    ];
    if (isCreatingNewTarget(modal.target)) {
      const name = modal.target.newName;
      lines.push(
        selectorLine(
          "New branch name",
          name.length === 0 ? "(type a name)" : name,
          modal.focus === "branch_name",
          this.#palette,
        ),
      );
    }
    return lines;
  }

  #renderNewRun(modal: NewRunModalState, width: number, height: number): string[] {
    const inner = Math.max(1, width - 2);
    const runType = this.#snapshot.runTypes.find((item) => item.id === modal.runTypeId);
    const objectiveRows = height >= 30 ? 3 : 1;
    const objectiveSource =
      modal.focus === "objective"
        ? insertCaret(modal.objective, modal.objectiveCursor)
        : modal.objective.length === 0
          ? "Describe the outcome…"
          : modal.objective;
    const objectiveLines = wrapTextWithAnsi(objectiveSource, inner - 2);
    const objectiveCaretLine = Math.max(
      0,
      objectiveLines.findIndex((line) => line.includes("▌")),
    );
    const objectiveStart =
      modal.focus === "objective"
        ? Math.max(0, objectiveCaretLine - objectiveRows + 1)
        : Math.max(0, objectiveLines.length - objectiveRows);
    const objectiveVisible = objectiveLines.slice(objectiveStart, objectiveStart + objectiveRows);
    const intakeLines =
      runType === undefined
        ? []
        : newRunAdditionalIntakeLines(modal, runType, inner, this.#palette);
    const runTypeBadges = this.#snapshot.runTypes.map((item) =>
      runTypeBadge(
        item.title,
        item.id === modal.runTypeId,
        modal.focus === "run_type" && item.id === modal.runTypeId,
        this.#palette,
      ),
    );
    const runTypeLines = wrapSegments(runTypeBadges, inner);
    const fixedRows =
      15 + objectiveVisible.length + intakeLines.length + modal.roles.length + runTypeLines.length;
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
        ...wrapStyled(
          `${marker} ${stage.title}`,
          inner,
          stage.included ? this.#palette.text : this.#palette.dim,
        ),
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
        selectorWindow(
          this.#snapshot.runTypes.map((item) => item.title),
          Math.max(
            0,
            this.#snapshot.runTypes.findIndex((item) => item.id === modal.runTypeId),
          ),
          inner,
          this.#palette,
        ),
        ...this.#newRunTargetLines(modal),
        `${modal.focus === "stages" ? this.#palette.accent("›") : " "} ${this.#palette.bold(`Stages ${stageStart + 1}/${stages.length}`)} · ${stage?.included === false ? this.#palette.dim(stage.title) : this.#palette.text(stage?.title ?? "No stages")}`,
        `${this.#palette.muted("Questions")} ${["none", "some", "many"].map((value) => questionBadge(value, modal.questionPolicy === value, this.#palette)).join(" ")}  ${this.#palette.muted("Parallel")} ${inputBadge(String(modal.maxParallel), modal.focus === "parallel", this.#palette)}`,
        `${" ".repeat(13)}${this.#palette.muted("Model")}           ${this.#palette.muted("Reasoning")}`,
      ];
      for (const role of modal.roles) {
        const model = this.#snapshot.models.find(
          (item) => item.provider === role.provider && item.id === role.model,
        );
        const modelLabel = `${model?.name ?? role.model}${model?.available === false ? " !" : ""}`;
        compact.push(
          `${role.title.padEnd(12)} ${inputBadge(modelLabel, modal.focus === `role:${role.id}:model`, this.#palette)} ${inputBadge(role.thinkingLevel, modal.focus === `role:${role.id}:thinking`, this.#palette, thinkingStyle)}`,
        );
      }
      const warning = selectedModelWarning(modal, this.#snapshot.models);
      if (warning !== undefined)
        compact.push(this.#palette.warning(truncateToWidth(warning, inner, "…", true)));
      const label = runType?.startMode === "work" ? "Start Work" : "Start Planning";
      compact.push(centeredButton(label, modal.focus === "start", this.#palette));
      compact.push(
        this.#palette.dim(
          "Tab/↑↓ move · ←→ change · PgUp/PgDn stages · Enter select · Esc close · h help",
        ),
      );
      return panel("New run", compact, width, height, true, this.#palette);
    }
    const lines = [
      centeredDivider("Goal Prompt", inner, this.#palette),
      ...objectiveVisible.map((line) =>
        modal.focus === "objective" ? this.#palette.selected(` ${line}`) : ` ${line}`,
      ),
      ...intakeLines,
      centeredDivider("Run Config", inner, this.#palette),
      ...runTypeLines,
      ...this.#newRunTargetLines(modal),
      `${modal.focus === "stages" ? this.#palette.accent("›") : " "} ${this.#palette.bold("Stages")} ${this.#palette.muted(`${stageStart + 1}–${Math.min(stages.length, stageStart + stageCount)} of ${stages.length}`)}`,
      ...stageLines,
      `${this.#palette.muted("Questions")} ${["none", "some", "many"].map((value) => questionBadge(value, modal.questionPolicy === value, this.#palette)).join(" ")}`,
      selectorLine(
        "Max parallel agents",
        String(modal.maxParallel),
        modal.focus === "parallel",
        this.#palette,
      ),
      `${" ".repeat(Math.min(24, Math.max(0, inner - 30)))}${this.#palette.muted("Model")}           ${this.#palette.muted("Reasoning")}`,
    ];
    for (const role of modal.roles) {
      const modelFocus = modal.focus === `role:${role.id}:model`;
      const thinkingFocus = modal.focus === `role:${role.id}:thinking`;
      const model = this.#snapshot.models.find(
        (item) => item.provider === role.provider && item.id === role.model,
      );
      const modelLabel = `${model?.name ?? role.model}${model?.available === false ? " !" : ""}`;
      lines.push(
        `${role.title.padEnd(12)} ${inputBadge(modelLabel, modelFocus, this.#palette)} ${inputBadge(role.thinkingLevel, thinkingFocus, this.#palette, thinkingStyle)}`,
      );
    }
    const warning = selectedModelWarning(modal, this.#snapshot.models);
    if (warning !== undefined) lines.push(...wrapStyled(warning, inner, this.#palette.warning));
    const label = runType?.startMode === "work" ? "Start Work" : "Start Planning";
    lines.push("", centeredButton(label, modal.focus === "start", this.#palette));
    lines.push(
      this.#palette.dim(
        "Tab/↑↓ moves · ←→ changes · PgUp/PgDn stages · Enter newline/select · Esc close · h help",
      ),
    );
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
    const tabs = sections
      .map((section, index) =>
        selectorBadge(section.title, index === modal.sectionIndex, this.#palette),
      )
      .join(this.#palette.muted("  "));
    const document: string[] = [];
    if (current.items.length === 0) {
      document.push(
        this.#palette.muted(
          "No agent-authored concise review items were recorded for this section.",
        ),
      );
    } else {
      current.items.forEach((item, index) => {
        if (index > 0) document.push("");
        document.push(this.#palette.bold(item.title));
        document.push(...wrapStyled(item.description, inner, this.#palette.text));
      });
    }
    if (current.id === "verification" && (approval?.graphSeed.length ?? 0) > 0) {
      document.push("", sectionHeading("Graph Seed", this.#palette));
      document.push(
        ...approval!.graphSeed.flatMap((line) => wrapStyled(line, inner, this.#palette.muted)),
      );
    }
    const steeringSource =
      modal.focus === "steering"
        ? insertCaret(modal.steering, modal.steeringCursor)
        : modal.steering.length === 0
          ? selectedRun?.plan.planningSessionId === undefined
            ? "Add steering here to request a revised plan…"
            : "Revise the current plan with steering…"
          : modal.steering;
    const steeringLines = wrapTextWithAnsi(steeringSource, inner - 2);
    const editorRows = Math.max(2, Math.min(4, Math.floor(height / 5)));
    const bodyRows = Math.max(2, height - editorRows - 11);
    const bodyStart = Math.min(modal.scroll, Math.max(0, document.length - bodyRows));
    const visibleDocument = document.slice(bodyStart, bodyStart + bodyRows);
    while (visibleDocument.length < bodyRows) visibleDocument.push("");
    const steeringCaretLine = Math.max(
      0,
      steeringLines.findIndex((line) => line.includes("▌")),
    );
    const steeringStart =
      modal.focus === "steering"
        ? Math.max(0, steeringCaretLine - editorRows + 1)
        : Math.max(0, steeringLines.length - editorRows);
    const steeringVisible = steeringLines.slice(steeringStart, steeringStart + editorRows);
    while (steeringVisible.length < editorRows) steeringVisible.push("");
    const hasSteering = modal.steering.trim().length > 0;
    const button = hasSteering ? "Revise plan" : "Approve run";
    const lines = [
      `${this.#palette.muted("Objective")} ${truncateToWidth(selectedRun?.objective.text ?? "Selected run", Math.max(1, inner - 10), "…")}`,
      `${this.#palette.muted("Run type")} ${selectedRun?.header.runType ?? "Unknown"}`,
      ...(selectedRun?.plan.revision === undefined
        ? []
        : [`${this.#palette.muted("Checkpoint")} Revision ${selectedRun.plan.revision}`]),
      ...(selectedRun?.plan.planningSessionId === undefined
        ? []
        : [this.#palette.muted("Same planner session; token allowance reset for this revision")]),
      "",
      tabs,
      ...visibleDocument,
      centeredDivider("Steering instructions", inner, this.#palette),
      ...steeringVisible.map(
        (line) =>
          ` ${modal.steering.length === 0 && modal.focus !== "steering" ? this.#palette.dim(line) : line}`,
      ),
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

    const messageSource =
      modal.focus === "message"
        ? insertCaret(modal.message, modal.messageCursor)
        : modal.message.length === 0
          ? "Optional context for this decision…"
          : modal.message;
    const messageLines = wrapTextWithAnsi(messageSource, Math.max(1, inner - 2));
    const caretLine = Math.max(
      0,
      messageLines.findIndex((line) => line.includes("▌")),
    );
    const messageStart =
      modal.focus === "message"
        ? Math.max(0, caretLine - editorRows + 1)
        : Math.max(0, messageLines.length - editorRows);
    const visibleMessage = messageLines.slice(messageStart, messageStart + editorRows);
    while (visibleMessage.length < editorRows) visibleMessage.push("");

    const lines = [
      ...visibleDocument,
      centeredDivider("Decision message (optional)", inner, this.#palette),
      ...visibleMessage.map(
        (line) =>
          ` ${modal.message.length === 0 && modal.focus !== "message" ? this.#palette.dim(line) : line}`,
      ),
      centerButtons(
        [
          {
            label: "Approve proposal",
            selected: modal.focus === "choice" && modal.decision === "approval",
            tone: "success",
          },
          {
            label: "Reject proposal",
            selected: modal.focus === "choice" && modal.decision === "rejection",
            tone: "danger",
          },
        ],
        this.#palette,
      ),
      centeredButton(
        modal.decision === "approval"
          ? "Record approval"
          : modal.decision === "rejection"
            ? "Record rejection"
            : "Choose a decision",
        modal.focus === "submit",
        this.#palette,
      ),
      this.#palette.dim(
        "↑↓ scroll · Tab focus · ←→ choose · Enter navigate/newline · Ctrl-Enter record · Esc close",
      ),
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
    const contentHeight = Math.max(
      5,
      height - 8 - Number(modal.rebaseRequired) - Number(hasUpstream),
    );
    const leftWidth = Math.max(18, Math.min(32, Math.floor(inner * 0.31)));
    const rightWidth = Math.max(1, inner - leftWidth - 1);
    const tree = (section?.resources ?? []).map((item, index) => {
      const selected = index === modal.resourceIndex;
      const indent = "  ".repeat(Math.max(0, item.depth ?? 0));
      const row = `${indent}${index === (section?.resources.length ?? 0) - 1 ? "└" : "├"} ${item.title}`;
      return selected ? this.#palette.selected(row) : this.#palette.muted(row);
    });
    const right: string[] = [];
    if (resource === undefined)
      right.push(this.#palette.muted("No configurable resources in this section."));
    else {
      right.push(sectionHeading(resource.title, this.#palette));
      right.push(...wrapStyled(resource.description, rightWidth, this.#palette.muted), "");
      resource.fields.forEach((field, index) => {
        const selected = index === modal.fieldIndex;
        const value = configValueLabel(field, modal.draft[field.key], this.#snapshot.models);
        const textField = isConfigTextField(field);
        const line =
          textField && selected
            ? `${selected ? "›" : " "} ${field.label}`
            : `${selected ? "›" : " "} ${field.label}  ${inputBadge(value, selected && modal.focus === "field", this.#palette)}`;
        right.push(selected ? this.#palette.text(line) : this.#palette.muted(line));
        if (selected) {
          right.push(
            ...wrapStyled(
              field.description,
              rightWidth - 2,
              (text) => `  ${this.#palette.dim(text)}`,
            ),
          );
          const rawModel = modal.draft[field.key];
          if (field.kind === "model" && typeof rawModel === "string") {
            const configured = configuredModelOption(rawModel, this.#snapshot.models);
            if (configured?.available === false) {
              right.push(
                ...wrapStyled(
                  `  Unavailable: ${configured.unavailableReason ?? "The contained Pi runtime cannot execute this model."}`,
                  rightWidth - 2,
                  this.#palette.warning,
                ),
              );
            }
          }
          if (field.kind === "thinking" && typeof rawModel === "string") {
            const modelField = resource.fields.find((candidate) => candidate.kind === "model");
            const configuredModel =
              modelField === undefined
                ? undefined
                : typeof modal.draft[modelField.key] === "string"
                  ? configuredModelOption(
                      modal.draft[modelField.key] as string,
                      this.#snapshot.models,
                    )
                  : undefined;
            if (
              configuredModel !== undefined &&
              !configuredModel.thinkingLevels.some((level) => level === rawModel)
            ) {
              right.push(
                ...wrapStyled(
                  `  Unsupported for ${configuredModel.name}. Choose: ${configuredModel.thinkingLevels.join(", ")}.`,
                  rightWidth - 2,
                  this.#palette.warning,
                ),
              );
            }
          }
          if (textField) {
            const stored = modal.draft[field.key];
            const raw =
              modal.textEditor?.key === field.key
                ? modal.textEditor.value
                : typeof stored === "string"
                  ? stored
                  : field.kind === "string_list" && Array.isArray(stored)
                    ? stored.filter((item): item is string => typeof item === "string").join("\n")
                    : "";
            const shown = raw.length === 0 ? this.#palette.dim("Empty") : raw;
            right.push(
              ...wrapStyled(
                `${modal.focus === "field" && modal.editing ? "▌ " : "  "}${shown}`,
                Math.max(1, rightWidth - 2),
                (text) =>
                  modal.focus === "field" ? this.#palette.selected(text) : this.#palette.text(text),
              ),
            );
          }
        }
      });
    }
    const leftStart = Math.max(
      0,
      Math.min(
        modal.resourceIndex - Math.floor(contentHeight / 2),
        Math.max(0, tree.length - contentHeight),
      ),
    );
    const rightSelectedLine = Math.max(
      0,
      right.findIndex((line) => line.includes("›")),
    );
    const rightStart = Math.max(
      0,
      Math.min(
        rightSelectedLine - Math.floor(contentHeight / 2),
        Math.max(0, right.length - contentHeight),
      ),
    );
    const joined = joinColumns(
      [
        tree.slice(leftStart, leftStart + contentHeight),
        right.slice(rightStart, rightStart + contentHeight),
      ],
      [leftWidth, rightWidth],
      contentHeight,
    );
    const actions = configResourceActions(modal);
    const actionLabels: Record<(typeof actions)[number], string> = {
      create: "[a] Add",
      duplicate: "[d] Duplicate",
      delete: "[x] Delete",
    };
    const actionRow =
      actions.length === 0
        ? this.#palette.dim("No collection actions for this resource")
        : actions
            .map((action, index) =>
              selectorBadge(
                actionLabels[action],
                modal.focus === "actions" && modal.actionIndex === index,
                this.#palette,
              ),
            )
            .join(" ");
    const publish = modal.dirty ? "Publish changes" : "Configuration current";
    return panel(
      "Configure",
      [
        sections,
        this.#palette.muted(section?.description ?? ""),
        ...(hasUpstream
          ? [
              this.#palette.warning(
                `${modal.upstreamConflicts.conflicts.length} upstream ${modal.upstreamConflicts.conflicts.length === 1 ? "change needs" : "changes need"} review · [u] Open comparison`,
              ),
            ]
          : []),
        ...(modal.rebaseRequired
          ? [this.#palette.warning("Saved draft is stale · Ctrl-R rebase or Ctrl-D discard")]
          : []),
        ...joined,
        actionRow,
        centeredButton(publish, modal.focus === "publish", this.#palette),
        this.#palette.dim(
          "←→ sections/values/actions · ↑↓ resources/fields · Tab focus · Enter select · u upstream changes · a add · d duplicate · x delete · Ctrl-S save · Ctrl-R rebase · Ctrl-P publish · Ctrl-D discard · Esc close · h help",
        ),
      ],
      width,
      height,
      true,
      this.#palette,
    );
  }

  #renderProfileConflicts(
    modal: ProfileConflictsModalState,
    width: number,
    height: number,
  ): string[] {
    const inner = Math.max(1, width - 2);
    const selected = modal.catalog.conflicts[modal.selectedIndex] ?? modal.inspection.conflict;
    const labels = modal.catalog.conflicts.map(
      (conflict) => `${conflict.title} · ${conflict.reason}`,
    );
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
    const comparison = joinColumns(
      [current.slice(start, start + bodyHeight), upstream.slice(start, start + bodyHeight)],
      [leftWidth, rightWidth],
      bodyHeight,
    );
    const actions = ["Keep project", "Use update"];
    const actionRow = actions
      .map((label, index) =>
        selectorBadge(
          label,
          modal.focus === "actions" && modal.actionIndex === index,
          this.#palette,
        ),
      )
      .join("  ");
    return panel(
      "Upstream changes",
      [
        selector,
        `${modal.focus === "list" ? this.#palette.accent("›") : " "} ${this.#palette.bold(selected.title)} ${this.#palette.muted(`· ${conflictReason(selected.reason)} · ${selected.domain}`)}`,
        this.#palette.dim(selected.path),
        joinColumns(
          [
            [sectionHeading("Project version", this.#palette)],
            [sectionHeading("Upstream update", this.#palette)],
          ],
          [leftWidth, rightWidth],
          1,
        )[0]!,
        ...comparison,
        actionRow,
        this.#palette.dim(
          "↑↓/jk change resource · PgUp/PgDn scroll · Tab actions · ←→ choose · Enter resolve · Esc back · h help",
        ),
      ],
      width,
      height,
      true,
      this.#palette,
    );
  }

  #renderConfigResourceOperation(
    modal: ConfigureModalState,
    width: number,
    height: number,
  ): string[] {
    const operation = modal.resourceOperation!;
    const inner = Math.max(1, width - 2);
    const option = operation.options[operation.templateIndex];
    const title =
      operation.kind === "create"
        ? "Add resource"
        : operation.kind === "duplicate"
          ? "Duplicate resource"
          : "Delete resource";
    const lines: string[] = [];
    if (operation.kind === "create") {
      lines.push(sectionHeading("Resource type", this.#palette));
      lines.push(
        selectorWindow(
          operation.options.map((candidate) => candidate.title),
          operation.templateIndex,
          inner,
          this.#palette,
        ),
      );
      if (option !== undefined) {
        lines.push(
          ...boundedWrapped(
            option.description,
            inner,
            Math.max(1, height - 11),
            this.#palette.muted,
          ),
        );
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
      const label = operation.kind === "create" ? (option?.nameLabel ?? "Name") : "Copy name";
      lines.push(
        "",
        sectionHeading(label, this.#palette),
        operation.focus === "name"
          ? this.#palette.selected(
              `▌ ${operation.name.length === 0 ? "Enter a name" : operation.name}`,
            )
          : inputBadge(
              operation.name.length === 0 ? "Enter a name" : operation.name,
              false,
              this.#palette,
            ),
      );
    }
    const button =
      operation.kind === "create"
        ? "Create resource"
        : operation.kind === "duplicate"
          ? "Duplicate resource"
          : "Delete resource";
    lines.push(
      "",
      centeredButton(button, operation.focus === "confirm", this.#palette),
      this.#palette.dim(
        operation.kind === "create" && operation.options.length > 1
          ? "←→ type · Tab/↑↓ focus · Enter select/confirm · Esc cancel · h help"
          : "Tab/↑↓ focus · Enter select/confirm · Esc cancel · h help",
      ),
    );
    return panel(
      title,
      lines,
      width,
      Math.min(height, Math.max(10, lines.length + 2)),
      true,
      this.#palette,
    );
  }

  #animatedCog(): string {
    const styles = [
      this.#palette.accent,
      this.#palette.info,
      this.#palette.success,
      this.#palette.info,
    ] as const;
    return styles[this.#animationFrame]!("⚙");
  }
}

function helpWorkflow(topic: ControlCenterHelpTopic): string {
  if (topic === "runs" || topic === "new_run")
    return "Runs are the durable top-level units Koni plans, schedules, verifies, and prepares for an operator-authorized merge.";
  if (topic === "tickets" || topic === "agents" || topic === "chat")
    return "The compiler turns the run specification into tickets; exact agent attempts carry out bounded ticket steps and preserve their Pi sessions.";
  if (topic === "questions" || topic === "answer_question")
    return "Questions stop ambiguous work at a durable decision boundary. Your answer is recorded before the responsible work can continue.";
  if (topic === "action_palette" || topic === "action_form")
    return "The compiler projects exactly which run and stage actions exist now. Koni revalidates the opaque action, run revision, generation, fields, and confirmation before any effect.";
  if (topic === "plan_review")
    return "Planning turns the goal into architecture, decisions, risk controls, verification, and an initial graph. Work starts only after explicit approval.";
  if (topic === "proposal_review")
    return "Change proposals hold overlapping compiler work at a durable operator boundary. Inspection is read-only; only an explicit recorded approval or rejection advances authority state.";
  if (
    topic === "configure" ||
    topic === "configure_documents" ||
    topic === "config_document_create" ||
    topic === "config_document_rename" ||
    topic === "config_document_delete" ||
    topic === "config_run_type_wizard" ||
    topic === "profile_conflicts" ||
    topic === "edit_scalar"
  )
    return "Configuration compiles project-owned profiles into the graph vocabulary, workflows, tickets, resources, models, and lifecycle rules used by future runs.";
  if (topic === "graph")
    return "The graph is the shared typed specification from which the compiler validates relationships and derives ready work.";
  if (topic === "activity")
    return "Activity is the human audit trail across compiler decisions, graph changes, agent work, Git, and lifecycle transitions.";
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
    // Pi mounts this component in place of its editor but keeps its own footer (and any
    // footer/status extensions) below it. Rendering the full terminal height therefore pushes
    // the dashboard's top rows off-screen; reserve the chrome rows instead.
    viewportRows: () =>
      Math.max(CONTROL_CENTER_MIN_HEIGHT, options.tui.terminal.rows - reservedPiChromeRows()),
    requestRender: () => options.tui.requestRender(),
  });
}

/**
 * Rows Pi keeps below the mounted dashboard. One row covers Pi's standard footer; operators with
 * taller footer/status extensions can widen the reserve with KONI_COCKPIT_RESERVED_ROWS.
 */
function reservedPiChromeRows(): number {
  const raw = Number.parseInt(process.env.KONI_COCKPIT_RESERVED_ROWS ?? "", 10);
  return Number.isSafeInteger(raw) && raw >= 0 && raw <= 12 ? raw : 1;
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
  const lines = panel(
    title,
    content.slice(start, start + capacity),
    width,
    safeHeight,
    focused,
    palette,
  );
  const safeWidth = Math.max(4, width);
  const inner = safeWidth - 2;
  const border = focused ? palette.borderActive : palette.border;
  const clipped = truncateToWidth(centerLine(footer, inner, palette.accent), inner, "…", true);
  lines[safeHeight - 2] =
    `${border("│")}${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}${border("│")}`;
  return lines;
}

function framedHeader(
  title: string,
  metadata: string,
  width: number,
  palette: KoniPalette,
): string[] {
  const inner = Math.max(1, width - 2);
  return [
    palette.border(`┌${"─".repeat(inner)}┐`),
    framedLine(` ${title}`, inner, palette),
    framedLine(` ${metadata}`, inner, palette),
    palette.border(`└${"─".repeat(inner)}┘`),
  ].map((line) => padLine(line, width));
}

/** Session bookkeeping notices whose content already renders in the chat panel title. */
const HEADER_NOTICE_TITLES = new Set([
  "Model changed",
  "Reasoning changed",
  "Session label",
  "Session name",
]);

/** Paints one chat message as a contiguous background-washed block. */
function surfaceBlock(lines: readonly string[], width: number, palette: KoniPalette): string[] {
  return lines.map((line) => {
    const clipped = truncateToWidth(line, width, "…", true);
    return palette.surface(`${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`);
  });
}

function detailsTitle(
  snapshot: ControlCenterControllerSnapshot,
  palette: KoniPalette,
  configuredTitle?: string,
): string {
  if (snapshot.selection.detailsTab === "chat") {
    const agent = snapshot.view.selectedRun?.agents.find(
      (candidate) => candidate.id === snapshot.selection.attemptId,
    );
    if (agent === undefined) return "Chat";
    return [
      `${agent.active ? "⚙ " : ""}Chat · ${agent.persona}`,
      ...(agent.stepTitle === undefined ? [agent.work] : [agent.stepTitle]),
      modelStyle(agent.model, palette),
      thinkingStyle(agent.thinking, palette),
    ].join(palette.muted(" · "));
  }
  const active = snapshot.selection.detailsTab;
  const label = (id: "graph" | "plan" | "overview", title: string): string =>
    id === active ? palette.text(title) : palette.muted(title);
  const tabs = [label("graph", "Graph"), label("plan", "Plan"), label("overview", "Overview")];
  return `${palette.muted(`${configuredTitle ?? "Details"}:`)} ${tabs.join(palette.muted(" - "))}`;
}

function joinColumns(
  columns: readonly string[][],
  widths: readonly number[],
  height: number,
): string[] {
  return Array.from({ length: height }, (_, row) =>
    columns.map((column, index) => padLine(column[row] ?? "", widths[index]!)).join(""),
  );
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
    body[start + index] =
      `${" ".repeat(left)}${clipped}${" ".repeat(Math.max(0, inner - left - visibleWidth(clipped)))}`;
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

/** Right-aligns `right` on the same line, truncating `left` first when space runs out. */
function overlayRight(left: string, right: string, width: number): string {
  const safeWidth = Math.max(1, width);
  if (visibleWidth(right) === 0) return truncateToWidth(left, safeWidth, "…", true);
  const rightWidth = visibleWidth(right);
  if (rightWidth + 1 >= safeWidth) return truncateToWidth(right, safeWidth, "…", true);
  const clippedLeft = truncateToWidth(left, safeWidth - rightWidth - 1, "…", true);
  return `${clippedLeft}${" ".repeat(Math.max(1, safeWidth - visibleWidth(clippedLeft) - rightWidth))}${right}`;
}

function stageTone(phase: string): KoniChipTone {
  switch (phase) {
    case "blocked":
    case "failed":
      return "error";
    case "paused":
    case "pausing":
      return "muted";
    case "awaiting_approval":
      return "warning";
    case "merge_ready":
    case "merging":
    case "completed":
      return "success";
    case "executing":
      return "accent";
    default:
      return "info";
  }
}

function framedLine(value: string, width: number, palette: KoniPalette): string {
  const clipped = truncateToWidth(value, width, "…", true);
  return `${palette.border("│")}${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}${palette.border("│")}`;
}

function wrapStyled(value: string, width: number, style: (line: string) => string): string[] {
  return wrapTextWithAnsi(value, Math.max(1, width)).map(style);
}

/**
 * Compact horizontal meter. A nonzero value always lights at least one cell and a partial value
 * never fills the meter, so progress reads truthfully at both boundaries.
 */
function meterBar(value: number, total: number, palette: KoniPalette, cells = 10): string {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) {
    return palette.dim("▱".repeat(cells));
  }
  const bounded = Math.max(0, Math.min(total, value));
  let filled = Math.round((bounded / total) * cells);
  if (bounded > 0 && filled === 0) filled = 1;
  if (bounded < total && filled === cells) filled = cells - 1;
  const tone = bounded >= total ? palette.success : palette.accent;
  return `${tone("▰".repeat(filled))}${palette.dim("▱".repeat(cells - filled))}`;
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
  buttons: readonly {
    label: string;
    selected: boolean;
    tone: "normal" | "success" | "danger" | "disabled";
  }[],
  palette: KoniPalette,
): string {
  const rendered = buttons
    .map((button) => {
      const body = `  ${button.label}  `;
      const toned =
        button.tone === "danger"
          ? palette.error(body)
          : button.tone === "success"
            ? palette.success(body)
            : button.tone === "disabled"
              ? palette.dim(body)
              : palette.text(body);
      return button.selected ? palette.selected(toned) : palette.border(`[${toned}]`);
    })
    .join("  ");
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
    const body = labels
      .slice(from, to)
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

function selectorLine(
  label: string,
  value: string,
  selected: boolean,
  palette: KoniPalette,
): string {
  return `${selected ? palette.accent("›") : " "} ${label}: ${inputBadge(value, selected, palette)}`;
}

function runTypeBadge(
  value: string,
  selected: boolean,
  focused: boolean,
  palette: KoniPalette,
): string {
  return `${focused ? palette.accent("›") : " "}${selectorBadge(value, selected, palette, modelStyle)}`;
}

function newRunAdditionalIntakeLines(
  modal: NewRunModalState,
  runType: ControlRunTypeOption,
  width: number,
  palette: KoniPalette,
): string[] {
  const lines: string[] = [];
  for (const field of runType.intake.filter(
    (candidate) => candidate.id !== runType.objectiveFieldId,
  )) {
    const focused = modal.focus === `intake:${field.id}`;
    lines.push("", palette.muted(`${field.label}${field.required ? " *" : ""}`));
    if (field.description.length > 0)
      lines.push(...wrapStyled(field.description, width, palette.dim));
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
    return [
      [false, true]
        .map((value) =>
          selectorBadge(
            value ? "yes" : "no",
            current === value || (focused && current === value),
            palette,
          ),
        )
        .join("  "),
    ];
  }
  if (field.kind === "choice" || field.kind === "multi_choice") {
    const selected =
      field.kind === "choice"
        ? new Set(
            typeof modal.intake[field.id] === "string" ? [modal.intake[field.id] as string] : [],
          )
        : new Set(
            Array.isArray(modal.intake[field.id])
              ? (modal.intake[field.id] as readonly unknown[]).filter(
                  (item): item is string => typeof item === "string",
                )
              : [],
          );
    const index = modal.intakeOptionIndexes[field.id] ?? 0;
    const result: string[] = [];
    field.options.forEach((option, optionIndex) => {
      const label = `${field.kind === "multi_choice" ? (selected.has(option.value) ? "✓ " : "□ ") : ""}${option.label}`;
      result.push(
        selectorBadge(
          label,
          selected.has(option.value) || (focused && index === optionIndex),
          palette,
        ),
      );
      if (option.description !== undefined)
        result.push(
          ...wrapStyled(option.description, Math.max(1, width - 2), palette.dim).map(
            (line) => `  ${line}`,
          ),
        );
    });
    if (field.kind === "multi_choice") result.push(palette.dim("←/→ choose · Enter toggles"));
    return result;
  }
  const source = modal.intakeText[field.id] ?? "";
  const cursor = modal.intakeCursors[field.id] ?? 0;
  const display = focused
    ? `${Array.from(source).slice(0, cursor).join("")}▌${Array.from(source).slice(cursor).join("")}`
    : source.length === 0
      ? "Enter a value…"
      : source;
  const wrapped = wrapTextWithAnsi(display, Math.max(1, width - 1));
  const limit = field.kind === "text" || field.kind === "json" ? 8 : 2;
  return wrapped
    .slice(0, limit)
    .map((line) =>
      focused
        ? palette.selected(` ${line}`)
        : source.length === 0
          ? palette.dim(` ${line}`)
          : ` ${line}`,
    );
}

function questionBadge(value: string, selected: boolean, palette: KoniPalette): string {
  const label = value === "none" ? "no" : value;
  const color = (text: string): string =>
    value === "none"
      ? palette.muted(text)
      : value === "some"
        ? palette.info(text)
        : palette.warning(text);
  const badge = color(` ${label} `);
  return selected ? palette.selected(badge) : palette.border(`[${badge}]`);
}

/** Per-domain icon + tint so each config lane reads as its own semantic group. */
function configDomainStyle(
  id: string,
  palette: KoniPalette,
): { icon: string; tint: (value: string) => string } {
  const n = id.toLocaleLowerCase("en-US");
  if (n.includes("run")) return { icon: "▶", tint: palette.accent };
  if (n.includes("agent")) return { icon: "●", tint: palette.error };
  if (n.includes("skill")) return { icon: "✦", tint: palette.success };
  if (n.includes("workflow") || n.includes("ticket")) return { icon: "▦", tint: palette.warning };
  if (n.includes("graph") || n.includes("rule")) return { icon: "◇", tint: palette.info };
  if (n.includes("action") || n.includes("check")) return { icon: "⚡", tint: palette.error };
  if (n.includes("report") || n.includes("view")) return { icon: "▤", tint: palette.success };
  if (n.includes("advanced")) return { icon: "⚙", tint: palette.muted };
  return { icon: "◆", tint: palette.info };
}

/** A left-nav lane row: colored icon on rest rows, a caret + reverse-video wash when active. */
function configDomainRow(id: string, title: string, active: boolean, palette: KoniPalette): string {
  const { icon, tint } = configDomainStyle(id, palette);
  if (active) return palette.selected(`▸ ${icon} ${title}`);
  return `  ${tint(icon)} ${palette.text(title)}`;
}

/** Value-chip tint keyed to the field kind (mirrors the Rust scalar palette). */
function configScalarTint(
  kind: string,
  palette: KoniPalette,
): (value: string, palette: KoniPalette) => string {
  if (kind === "boolean") return (value) => palette.warning(value);
  if (kind === "integer") return (value) => palette.info(value);
  if (kind === "model" || kind === "thinking" || kind === "select")
    return (value) => palette.accent(value);
  return (value) => palette.success(value);
}

function configFieldDirty(field: ConfigFieldDefinition, modal: ConfigureModalState): boolean {
  if (!(field.key in modal.draft)) return false;
  return (
    JSON.stringify(modal.draft[field.key]) !== JSON.stringify(modal.snapshot.values[field.key])
  );
}

function configResourceDirty(
  fields: readonly ConfigFieldDefinition[],
  modal: ConfigureModalState,
): boolean {
  return fields.some((field) => configFieldDirty(field, modal));
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
  if (normalized.includes("run") || normalized.includes("active"))
    return palette.accent(`⚙ ${status}`);
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

function recentActivityTitle(
  duration: string | undefined,
  width: number,
  configuredTitle = "Activity",
): string {
  if (duration === undefined) return configuredTitle;
  const full = `${configuredTitle} · ${duration} active`;
  if (visibleWidth(full) <= width) return full;
  const compact = `${configuredTitle} · ${duration.replace(/\s+/gu, "")}`;
  if (visibleWidth(compact) <= width) return compact;
  return visibleWidth(configuredTitle) <= width
    ? configuredTitle
    : truncateToWidth(configuredTitle, width, "…");
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

function footerHelp(width: number): string {
  const candidates = [
    "[n] new  [a] actions  [c] configure  [v] review  [Tab] panels  [↑↓/jk] move  [Enter] select  [←→/[]] tabs  [Space] pause  [m] merge  [d] delete  [h] help  [Esc/q] close",
    "[n] new  [a] actions  [c] config  [v] review  [Tab] panels  [↑↓/jk] move  [Enter] select  [Space] pause  [h] help  [Esc/q] close",
    "[n] new  [a] actions  [c] config  [Tab] panels  [↑↓] move  [h] help  [Esc/q] close",
  ];
  return (
    candidates.find((candidate) => visibleWidth(candidate) <= width) ??
    "[n] new  [a] actions  [c] config  [h] help  [q] close"
  );
}

function modalEditingText(snapshot: ControlCenterControllerSnapshot): boolean {
  const modal = snapshot.modal;
  return (
    (modal?.kind === "new_run" && modal.focus === "objective") ||
    (modal?.kind === "plan_review" && modal.focus === "steering") ||
    (modal?.kind === "proposal_review" && modal.focus === "message") ||
    modal?.kind === "edit_scalar" ||
    (modal?.kind === "action_form" && modal.editing) ||
    (modal?.kind === "configure" && (modal.editing || modal.resourceOperation?.focus === "name")) ||
    (modal?.kind === "configure_documents" && modal.editing) ||
    (modal?.kind === "config_document_create" && modal.focus === "title") ||
    (modal?.kind === "config_document_rename" && modal.focus === "title") ||
    (modal?.kind === "config_run_type_wizard" &&
      (modal.focus === "title" || modal.focus === "slug" || modal.focus === "description"))
  );
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
  return models.find(
    (model) => model.provider === value.slice(0, split) && model.id === value.slice(split + 1),
  );
}

function conflictDocumentLines(
  source: string | null,
  absentLabel: string,
  width: number,
  palette: KoniPalette,
): string[] {
  if (source === null) return [palette.muted(`(${absentLabel})`)];
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const rendered = lines.flatMap((line) =>
    wrapStyled(line.length === 0 ? " " : line, width, palette.text),
  );
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
  // An unexecutable selection is the more urgent message; a substitution notice explains why the
  // visible models are not the ones the profile declared.
  return sealedModelAdmissionIssue(modal.roles, models)?.message ?? modal.modelNotice;
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
  if (normalized.includes("complete") || normalized.includes("ready"))
    return palette.success(marker);
  if (normalized.includes("approval") || normalized.includes("pause"))
    return palette.warning(marker);
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
    case "off":
      return palette.muted(level);
    case "minimal":
      return palette.dim(level);
    case "low":
      return palette.success(level);
    case "medium":
      return palette.info(level);
    case "high":
      return palette.accent(level);
    case "xhigh":
      return palette.warning(level);
    case "max":
      return palette.error(level);
    default:
      return palette.text(level);
  }
}

function activityStyle(
  kind: string,
  message: string,
  palette: KoniPalette,
  tone?: "info" | "success" | "warning" | "error",
): string {
  // An explicit effect tone recorded at the emit site wins; kind is the fallback heuristic.
  if (tone === "success") return palette.success(message);
  if (tone === "warning") return palette.warning(message);
  if (tone === "error") return palette.error(message);
  if (tone === "info") return palette.info(message);
  if (kind === "graph_added") return palette.success(message);
  if (kind === "graph_modified") return palette.warning(message);
  if (kind === "graph_deleted") return palette.error(message);
  if (kind === "agent") return palette.info(message);
  if (kind === "git") return palette.accent(message);
  return palette.text(message);
}

function overlayModal(base: readonly string[], modal: readonly string[], width: number): string[] {
  const output = [...base];
  const modalWidth = Math.min(width, Math.max(...modal.map(visibleWidth), 1));
  const left = Math.max(0, Math.floor((width - modalWidth) / 2));
  const top = Math.max(0, Math.floor((base.length - modal.length) / 2));
  modal.forEach((line, index) => {
    output[top + index] =
      `${" ".repeat(left)}${truncateToWidth(line, modalWidth, "", true)}${" ".repeat(Math.max(0, width - left - modalWidth))}`;
  });
  return output;
}

function annotateOperateHitTargets(
  frame: CellGrid,
  layout: OperateLayout,
  snapshot: ControlCenterControllerSnapshot,
): void {
  const selectedRunIndex = Math.max(
    0,
    snapshot.view.runs.findIndex((run) => run.id === snapshot.selection.runId),
  );
  addTwoLineListTargets({
    frame,
    rect: layout.runs,
    ids: snapshot.view.runs.map((run) => `run:${run.id}`),
    selectedLine: 1 + selectedRunIndex * 2,
    scroll: snapshot.scroll.runs,
    fixedFooter: false,
    leadingLines: 1,
  });

  const tickets = snapshot.view.selectedRun?.tickets ?? [];
  const ticketCursorId = snapshot.cursor.ticketId ?? snapshot.selection.ticketId;
  const selectedTicketIndex = Math.max(
    0,
    tickets.findIndex((ticket) => ticket.id === ticketCursorId),
  );
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
  const agentCursorId = snapshot.cursor.attemptId ?? snapshot.selection.attemptId;
  const selectedAgentIndex = Math.max(
    0,
    agents.findIndex((agent) => agent.id === agentCursorId),
  );
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
  for (const tab of ["graph", "plan", "overview"] as const) {
    frame.addTextHitTarget(`details-tab:${tab}`, titleCaseLabel(tab), layout.details);
  }
  frame.addTextHitTarget("ticket-tab:previous", "‹", layout.tickets);
  frame.addTextHitTarget("ticket-tab:next", "›", layout.tickets);
  frame.addTextHitTarget("run-tab:previous", "‹", layout.runs);
  frame.addTextHitTarget("run-tab:next", "›", layout.runs);
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
    frame.addTextHitTarget(
      "new-run:start",
      selected?.startMode === "work" ? "Start Work" : "Start Planning",
    );
  } else if (modal.kind === "plan_review") {
    const sections = snapshot.view.selectedRun?.approval?.sections ?? [];
    sections.forEach((section, index) =>
      frame.addTextHitTarget(`plan:section:${index}`, section.title),
    );
    frame.addTextHitTarget("plan:steering", "Steering instructions");
    frame.addTextHitTarget(
      "plan:action",
      modal.steering.trim().length > 0 ? "Revise plan" : "Approve run",
    );
  } else if (modal.kind === "proposal_review") {
    frame.addTextHitTarget("proposal:message", "Decision message (optional)");
    frame.addTextHitTarget("proposal:approve", "Approve proposal");
    frame.addTextHitTarget("proposal:reject", "Reject proposal");
    frame.addTextHitTarget(
      "proposal:submit",
      modal.decision === "approval"
        ? "Record approval"
        : modal.decision === "rejection"
          ? "Record rejection"
          : "Choose a decision",
    );
  } else if (modal.kind === "answer_question") {
    const question = snapshot.view.selectedRun?.questions?.find(
      (candidate) => candidate.id === modal.questionId,
    );
    question?.options.forEach((option, index) =>
      frame.addTextHitTarget(`answer:option:${index}`, option.label),
    );
    frame.addTextHitTarget("answer:option:none", "None of the above");
    frame.addTextHitTarget("answer:notes", "Notes (optional)");
    frame.addTextHitTarget("answer:submit", "Submit answer");
  } else if (modal.kind === "action_palette") {
    modal.actions.forEach((action, index) =>
      frame.addTextHitTarget(`action-palette:${index}`, action.title),
    );
  } else if (modal.kind === "action_form") {
    modal.action.form?.fields.forEach((field, index) => {
      if (field.visibility !== "hidden")
        frame.addTextHitTarget(`action-field:${index}`, field.label);
    });
    if (modal.action.confirmation.required) {
      frame.addTextHitTarget("action-confirm", modal.action.confirmation.confirmLabel);
    }
    frame.addTextHitTarget("action-submit", modal.action.form?.submitLabel ?? modal.action.title);
  } else if (modal.kind === "config_document_create") {
    modal.choices.forEach((choice, index) =>
      frame.addTextHitTarget(`config-create:choice:${index}`, choice.label),
    );
    frame.addTextHitTarget("config-create:title", "Title");
    frame.addTextHitTarget("config-create:submit", "Create resource");
  } else if (modal.kind === "config_document_rename") {
    frame.addTextHitTarget("config-rename:title", "Title");
    frame.addTextHitTarget("config-rename:submit", "Rename resource");
  } else if (modal.kind === "config_document_delete") {
    frame.addTextHitTarget("config-delete:cancel", "Cancel");
    frame.addTextHitTarget("config-delete:confirm", "Delete resource");
  } else if (modal.kind === "config_run_type_wizard") {
    modal.templates.templates.forEach((template, index) =>
      frame.addTextHitTarget(`config-run-type:template:${index}`, template.title),
    );
    frame.addTextHitTarget("config-run-type:title", "Title");
    frame.addTextHitTarget("config-run-type:slug", "Slug");
    frame.addTextHitTarget("config-run-type:description", "Description");
    frame.addTextHitTarget("config-run-type:default", "Make this the project default");
    frame.addTextHitTarget("config-run-type:submit", "Create run type");
  } else if (modal.kind === "profile_conflicts") {
    frame.addTextHitTarget("conflict:action:project", "Keep project");
    frame.addTextHitTarget("conflict:action:upstream", "Use update");
  } else if (modal.kind === "configure" && modal.resourceOperation !== undefined) {
    const button =
      modal.resourceOperation.kind === "create"
        ? "Create resource"
        : modal.resourceOperation.kind === "duplicate"
          ? "Duplicate resource"
          : "Delete resource";
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
  return new Set<ControlCenterPanel>([
    "runs",
    "tickets",
    "agents",
    "details",
    "questions",
    "activity",
  ]).has(panel as ControlCenterPanel)
    ? (panel as ControlCenterPanel)
    : undefined;
}

const HELP: Readonly<
  Record<
    ControlCenterHelpTopic,
    {
      title: string;
      description: string;
      /** Repository-docs-style text diagram rendered under “How it fits”. */
      diagram?: readonly string[];
      /** Short paragraphs explaining why the surface behaves the way it does. */
      philosophy?: readonly string[];
      actions: readonly (readonly [string, string])[];
    }
  >
> = {
  runs: {
    title: "Runs",
    description:
      "Each run is a durable, isolated execution against the target branch shown in its row. Koni plans and works in its run worktree; only you publish a merge-ready result.",
    diagram: [
      "new ─▶ plan ─▶ approve ─▶ execute ─▶ verify ─▶ merge ready",
      "         │         ▲          │                    │",
      "     questions ────┘       blocked ─▶ retry     you merge",
    ],
    philosophy: [
      "A run owns its worktree and branch, so Koni can plan and work continuously without touching your checkout. Nothing reaches the target branch until you authorize the merge.",
      "The tab line filters the list — Active is the working set; paused, blocked, and concluded runs wait one tab away instead of crowding it. Rows are projections, never controls: selecting, filtering, and scrolling cannot mutate a run.",
    ],
    actions: [
      ["↑/↓ or j/k", "select run"],
      ["←/→ or [ ]", "switch filter tab"],
      ["Enter", "focus the run overview"],
      ["Space", "pause or resume"],
      ["m", "merge a ready run"],
      ["d", "stop and delete"],
    ],
  },
  tickets: {
    title: "Tickets",
    description:
      "The compiler derives tickets from the typed graph. Arrows only move the highlight; Enter selects the ticket and filters Details, Agents, and Graph to it. Esc returns to the run-wide view.",
    diagram: [
      "typed graph ─▶ compiler ─▶ tickets ─▶ steps ─▶ attempts",
      "     ▲                                            │",
      "     └────── receipts · checks · evidence ◀───────┘",
    ],
    philosophy: [
      "Tickets are compiled, never hand-written: the board always reflects the current specification, and finished work flows back into the graph as receipts and evidence. Committing a ticket scopes every downstream panel to its graph neighborhood.",
    ],
    actions: [
      ["↑/↓ or j/k", "highlight ticket"],
      ["Enter", "select and inspect ticket"],
      ["Esc", "clear ticket filter"],
    ],
  },
  details: {
    title: "Details",
    description:
      "Graph is the live feed of the run: its graph, active tickets, and working agents. Overview keeps Objective, Run, Evidence, and Stages together; a blocked run leads with its reason and recovery options. Plan shows live planning activity until submission, then the concise human-readable plan.",
    diagram: [
      "Graph ─▶ Plan ─▶ Overview",
      "Objective ─▶ Run vitals ─▶ Evidence ─▶ Stages",
      "                                      ● done ◐ current ○ pending",
    ],
    philosophy: [
      "Overview is one scrollable document, not nested mini-views, so the run's state reads top to bottom. Enter runs only the compiler-authorized action of the current stage — the panel can explain everything but can only do what authority projected.",
    ],
    actions: [
      ["[ ]", "switch tab (←/→ on Plan/Overview)"],
      ["↑/↓ or j/k", "scroll"],
      ["Ctrl-O/o", "expand objective"],
      ["Enter", "run the current stage action"],
      ["6", "jump to the Graph feed"],
    ],
  },
  questions: {
    title: "Questions",
    description:
      "Pending questions pause the responsible attempt. The inline panel previews the same choices, descriptions, None option, and notes used by the complete answer dialog.",
    diagram: [
      "agent hits ambiguity ─▶ durable question ─▶ your answer",
      "                                                │",
      "                        work resumes ◀──────────┘",
    ],
    philosophy: [
      "A question is a durable decision boundary: the responsible work stops, your answer is recorded first, and only then does execution continue. Ambiguity never silently resolves itself.",
    ],
    actions: [
      ["↑/↓ or j/k", "choose option"],
      ["←/→ or [ ]", "switch question"],
      ["n", "edit notes"],
      ["Enter", "open the answer dialog"],
    ],
  },
  agents: {
    title: "Agents",
    description:
      "Active and past attempts remain visible as a semantic lineage tree. Run-wide rows include their ticket prefix; selecting a ticket narrows the list. Retry, rework, review, recovery, parent/child, and active-leaf context never exposes internal IDs.",
    diagram: [
      "Lead ─┬─ design-experiment · attempt 1",
      "      │    └─ retry ─ attempt 2  ◀ active leaf",
      "      └─ implement-asset · attempt 1",
    ],
    philosophy: [
      "History is part of the record: failed and superseded attempts stay visible as lineage instead of disappearing, because recovery decisions need the whole tree. Every attempt keeps its complete Pi session for inspection.",
    ],
    actions: [
      ["↑/↓ or j/k", "highlight attempt"],
      ["Enter", "open attempt chat"],
      ["Ctrl-O/o", "show or hide tool results"],
      ["Esc", "leave chat"],
    ],
  },
  activity: {
    title: "Activity",
    description:
      "This durable feed combines compiler, graph, Git, and agent events. Green adds graph knowledge, yellow changes it, red deletes it, and timestamps show when each event happened.",
    philosophy: [
      "Activity is the human audit trail: it answers “what just happened and when” without asking you to reconstruct it from raw logs. Identifiers, paths, and digests are redacted so every row stays safe operator copy.",
    ],
    actions: [
      ["↑/↓ or j/k", "scroll"],
      ["PgUp/PgDn", "scroll a page"],
    ],
  },
  graph: {
    title: "Graph feed",
    description:
      "The Graph tab is the run's live feed: the typed context graph on the left, the active tickets exploring it on the right, and the agents working each ticket nested in its card. Connector lanes wire every active ticket to the exact nodes it changes.",
    diagram: [
      "[hypothesis] Continue research     ╭ ▍ Probe extraction",
      " ├─<claims>─[claim] Signatures ────┤   ⚙ implementer",
      " └─<methods>─[method] Probe ───────╯   opus · high · 48K",
    ],
    philosophy: [
      "The graph is what the compiler compiles: every ticket, check, and gate is derived from these nodes and relationships, so reading it is reading the run's real contract. The feed adds the present tense: which tickets embody the plan right now, and which cognition is spending tokens on them.",
      "Focusing a node or a ticket lights up its whole neighborhood — nodes, edges, lanes, and cards — while everything irrelevant greys out; Enter opens the node card or commits the ticket.",
    ],
    actions: [
      ["←/→", "switch between graph and tickets"],
      ["↑/↓ or j/k", "move the cursor"],
      ["Enter", "open node card / commit ticket"],
      ["[ ]", "switch details tab"],
      ["PgUp/PgDn", "move a page"],
    ],
  },
  new_run: {
    title: "New Run",
    description:
      "A run pins one target branch, run type, and set of run-local overrides. Skipped stages remain visible in muted text; publishing the form asks authority to validate everything again and immediately creates a provisional Runs row.",
    diagram: [
      "goal prompt ─▶ run type ─▶ target branch ─▶ models",
      "                                              │",
      "        provisional row ◀── authority ◀── Start",
    ],
    philosophy: [
      "Everything a run needs is pinned at creation — provider, models, stages, and target — so the run stays reproducible even while the project configuration moves on underneath it.",
    ],
    actions: [
      ["Tab or ↑/↓", "move between controls"],
      ["←/→", "change a selector"],
      ["PgUp/PgDn", "inspect every stage"],
      ["Enter", "newline, select, or start"],
    ],
  },
  plan_review: {
    title: "Review Plan",
    description:
      "The four sections are independently authored concise review summaries. Empty steering approves; steering revises the current plan in the same planning session. After approval, Details → Plan keeps these concise review summaries available.",
    diagram: [
      "objective ─▶ planner ─▶ architecture · decisions · risk · verification",
      "                              │",
      "     steering ─▶ revise ◀─────┴────▶ approve ─▶ work begins",
    ],
    philosophy: [
      "Work starts only after an explicit approval, so the exact revision you review is the contract execution receives. Steering continues the same planner session with a reset revision allowance and an immutable prior checkpoint.",
    ],
    actions: [
      ["←/→ or [ ]", "switch section"],
      ["↑/↓ or j/k", "scroll"],
      ["Tab", "move document/editor/action"],
      ["Ctrl-Enter", "perform the adaptive action"],
    ],
  },
  proposal_review: {
    title: "Review Change Proposal",
    description:
      "A model may propose an upstream graph or specification change, but only the compiler publishes this bounded review and only you may approve or reject it. The surface starts with no selected outcome.",
    philosophy: [
      "Agents can propose but never decide: a specification change waits at this durable boundary until you record a decision, and Enter deliberately cannot record one — only Ctrl-Enter does.",
    ],
    actions: [
      ["↑/↓ or j/k", "read the complete proposal"],
      ["Tab", "move through message, choice, and action"],
      ["←/→", "choose approval or rejection"],
      ["Ctrl-Enter", "record the reviewed decision"],
    ],
  },
  answer_question: {
    title: "Answer Question",
    description:
      "Questions are durable compiler-owned decisions. Compare every option and its description, choose None of the above when needed, add optional steering notes, then submit explicitly.",
    actions: [
      ["←/→ or [ ]", "switch pending question"],
      ["↑/↓ or j/k", "choose an option"],
      ["Tab", "move to notes or submit"],
      ["Ctrl-Enter", "submit the selected answer and notes"],
    ],
  },
  action_palette: {
    title: "Actions",
    description:
      "This palette is authored from current compiler and lifecycle state. Disabled actions stay visible with the exact reason; delete and merge always open their guarded review before any mutation.",
    actions: [
      ["↑/↓ or j/k", "choose an action"],
      ["Enter", "open or execute an available action"],
      ["Esc", "close without changing state"],
    ],
  },
  action_form: {
    title: "Action Form",
    description:
      "The compiler defines these semantic fields and locked context. Inputs are submitted with the exact run revision and generation; stale or altered requests fail closed at authority.",
    actions: [
      ["Tab or ↑/↓", "move between fields and action"],
      ["←/→", "change a selector or number"],
      ["Enter", "edit, select, or confirm"],
      ["Ctrl-Enter", "submit explicitly"],
    ],
  },
  configure: {
    title: "Configure",
    description:
      "Guided domains edit an in-memory project-overlay draft. Koni never makes YAML the primary interface. Publish sends the complete candidate and source-CAS token to authority; active and pinned runs are unchanged by a draft.",
    actions: [
      ["←/→", "change section, value, or action"],
      ["↑/↓", "choose resource or field"],
      ["r", "open semantic Project Resources"],
      ["u", "review staged upstream changes"],
      ["a / d / x", "add, duplicate, or delete resource"],
      ["Ctrl-S", "save in-memory draft"],
      ["Ctrl-R", "rebase a stale saved draft"],
      ["Ctrl-P", "validate and publish"],
      ["Ctrl-D", "discard draft"],
    ],
  },
  configure_documents: {
    title: "Project Resources",
    description:
      "This expert surface groups exact project-authored configuration by semantic domain. It edits source through authority-owned document and revision tokens; filesystem paths and compiler-owned files are never exposed as UI authority.",
    actions: [
      ["Tab", "move between domains, resources, and source"],
      ["Enter", "start or stop source editing"],
      ["Ctrl-S", "validate and save the exact document"],
      ["Ctrl-D", "discard the raw edit"],
      ["a / e / x", "create, rename, or review deletion"],
      ["t", "create a run type from a compiled template"],
      ["Esc", "return to Guided Configure when clean"],
    ],
  },
  config_document_create: {
    title: "New Project Resource",
    description:
      "Create one supported project-owned resource from a semantic type. Authority chooses its managed location, compiles the complete candidate, and publishes only a valid result.",
    actions: [
      ["←/→ or [ ]", "choose a resource type"],
      ["Tab", "move to title or action"],
      ["Enter", "continue or create"],
      ["Esc", "return without creating"],
    ],
  },
  config_document_rename: {
    title: "Rename Project Resource",
    description:
      "Rename the selected semantic resource under exact catalog and source revision checks. Required references are updated atomically by the configuration authority.",
    actions: [
      ["←/→", "move the title caret"],
      ["Tab", "move to the action"],
      ["Enter", "continue or rename"],
      ["Esc", "return without renaming"],
    ],
  },
  config_document_delete: {
    title: "Delete Project Resource",
    description:
      "Deletion is a reviewed, compiler-validated operation. The dialog keeps unavailable deletion visible with the authority-authored reason and cannot bypass that decision.",
    actions: [
      ["←/→", "choose Cancel or Delete"],
      ["Enter", "confirm the selected action"],
      ["Esc", "return without deleting"],
    ],
  },
  config_run_type_wizard: {
    title: "New Run Type",
    description:
      "Create a project run type by cloning a compiler-valid template, then give it a human title, optional slug and description, and an explicit default choice.",
    actions: [
      ["←/→", "choose a template or edit the caret"],
      ["Tab/↑/↓", "move between fields"],
      ["Enter", "continue, toggle, or add a description line"],
      ["Ctrl-Enter", "create the run type"],
      ["Esc", "return without creating"],
    ],
  },
  profile_conflicts: {
    title: "Upstream Changes",
    description:
      "Profile upgrades preserve project overrides and stage upstream changes for an explicit decision. Compare the complete project and upstream documents, then keep the project version or accept the authenticated update under source and lifecycle checks.",
    actions: [
      ["↑/↓ or j/k", "switch changed resource"],
      ["PgUp/PgDn", "scroll both documents"],
      ["Tab", "focus resolution actions"],
      ["←/→", "choose Keep project or Use update"],
      ["Enter", "apply the selected decision"],
      ["Esc", "return to Configure"],
    ],
  },
  edit_scalar: {
    title: "Edit Setting",
    description:
      "This editor changes only the in-memory Configure draft. Its Unicode caret moves by complete characters, the complete wrapped value remains reachable, and schema validation runs before the draft is updated.",
    actions: [
      ["←/→", "move the caret"],
      ["Home/End", "move to either boundary"],
      ["Backspace/Delete", "remove text around the caret"],
      ["Enter/Ctrl-Enter", "apply a scalar/multiline value"],
      ["Esc", "return without changing the draft"],
    ],
  },
  chat: {
    title: "Agent Chat",
    description:
      "This is the persisted Pi session itself: complete assistant messages, reasoning, calls, results, compaction, and branch points. Large items remain complete as ordered bounded parts. Only terminal and invisible-direction controls are stripped or replaced for safe display; canonical Pi JSONL is unchanged. Image bytes stay private while an ordered type-and-size attachment row remains visible. Steering and follow-ups still cross Koni authority before Pi receives them.",
    philosophy: [
      "You are reading the agent's real session, not a summary — which is why history is windowed instead of truncated. Messages you send cross Koni authority first, so steering an agent is as durable and auditable as any other operator action.",
    ],
    actions: [
      ["←/→ or [ ]", "move to adjacent older/newer history windows"],
      ["PgUp/PgDn", "scroll within the current bounded window"],
      ["r", "reload the current newest history"],
      ["Enter or s", "open the composer"],
      ["Tab", "switch steer/follow-up"],
      ["Ctrl-Enter", "send through authority"],
      ["Esc", "close the composer, then exit Chat"],
    ],
  },
};
