import type {
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import {
  CompactMonitorWidget,
  RunsOverlayComponent,
  compactMonitorStatus,
  type RunsOverlayResult,
} from "./component.js";
import type { MonitorController, MonitorNotice } from "./controller.js";
import { monitorPaletteFromPiTheme } from "./presentation.js";
import { GuidedRunModalComponent, type GuidedRunModalResult } from "./run-intake-component.js";
import type { GuidedRunState } from "./run-intake.js";

export type PiWidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };
export type PiCustomFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: T) => void,
) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;

/** Exact Pi 0.80.10 primitives used by the companion, injectable for provider-free tests. */
export interface PiMonitorHostAdapter {
  setWidget(
    key: string,
    content: PiWidgetFactory | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  setStatus(key: string, text: string | undefined): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: PiCustomFactory<T>,
    options?: {
      overlay?: boolean;
      overlayOptions?: OverlayOptions | (() => OverlayOptions);
    },
  ): Promise<T>;
}

export function piMonitorHostFromUi(
  ui: Pick<ExtensionUIContext, "setWidget" | "setStatus" | "notify" | "custom">,
): PiMonitorHostAdapter {
  return {
    setWidget(key, content, options) {
      ui.setWidget(key, content, options);
    },
    setStatus(key, text) {
      ui.setStatus(key, text);
    },
    notify(message, type) {
      ui.notify(message, type);
    },
    custom(factory, options) {
      return ui.custom(factory, options);
    },
  };
}

export interface PiMonitorBindingOptions {
  controller: MonitorController;
  host: PiMonitorHostAdapter;
  key?: string;
}

/** Owns only the keyed passive widget/status. It never starts the controller or opens an overlay. */
export class PiMonitorBinding {
  readonly #controller: MonitorController;
  readonly #host: PiMonitorHostAdapter;
  readonly #key: string;
  readonly #unsubscribe: () => void;
  #mounted = false;
  #disposed = false;

  public constructor(options: PiMonitorBindingOptions) {
    this.#controller = options.controller;
    this.#host = options.host;
    this.#key = options.key ?? "koni.monitor";
    this.#unsubscribe = this.#controller.subscribe(() => this.#sync());
    this.#sync();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#host.setWidget(this.#key, undefined, { placement: "aboveEditor" });
    this.#host.setStatus(this.#key, undefined);
    this.#mounted = false;
  }

  #sync(): void {
    if (this.#disposed) return;
    const snapshot = this.#controller.snapshot;
    const visible =
      snapshot.eligibility.trusted &&
      snapshot.eligibility.initialized &&
      snapshot.connection !== "disabled" &&
      snapshot.connection !== "suspended";
    if (visible && !this.#mounted) {
      this.#host.setWidget(
        this.#key,
        (tui, theme) =>
          new CompactMonitorWidget({
            controller: this.#controller,
            palette: monitorPaletteFromPiTheme(theme),
            requestRender: () => tui.requestRender(),
          }),
        { placement: "aboveEditor" },
      );
      this.#mounted = true;
    } else if (!visible && this.#mounted) {
      this.#host.setWidget(this.#key, undefined, { placement: "aboveEditor" });
      this.#mounted = false;
    }
    this.#host.setStatus(this.#key, visible ? compactMonitorStatus(snapshot) : undefined);
  }
}

export function notifyPiMonitor(host: PiMonitorHostAdapter, notice: MonitorNotice): void {
  host.notify(notice.message, notice.kind);
}

export async function openPiRunsOverlay(options: {
  host: PiMonitorHostAdapter;
  controller: MonitorController;
}): Promise<RunsOverlayResult> {
  let terminalWidth = 100;
  let terminalRows = 40;
  return options.host.custom<RunsOverlayResult>(
    (tui, theme, _keybindings, done) => {
      terminalWidth = tui.terminal.columns;
      terminalRows = tui.terminal.rows;
      const component = new RunsOverlayComponent({
        controller: options.controller,
        done,
        palette: monitorPaletteFromPiTheme(theme),
        viewportRows: () => Math.max(12, Math.floor(tui.terminal.rows * 0.78)),
        requestRender: () => tui.requestRender(),
      });
      component.focused = true;
      return component;
    },
    {
      overlay: true,
      overlayOptions: () => monitorOverlayOptions(terminalWidth, terminalRows, "runs"),
    },
  );
}

export async function openPiGuidedRunModal(options: {
  host: PiMonitorHostAdapter;
  state: GuidedRunState;
  create: (state: GuidedRunState) => Promise<{ runId: string; warning?: string }>;
}): Promise<GuidedRunModalResult> {
  let terminalWidth = 100;
  let terminalRows = 40;
  return options.host.custom<GuidedRunModalResult>(
    (tui, theme, _keybindings, done) => {
      terminalWidth = tui.terminal.columns;
      terminalRows = tui.terminal.rows;
      const component = new GuidedRunModalComponent({
        state: options.state,
        create: options.create,
        done,
        palette: monitorPaletteFromPiTheme(theme),
        viewportRows: () => Math.max(16, Math.floor(tui.terminal.rows * 0.88)),
        requestRender: () => tui.requestRender(),
      });
      component.focused = true;
      return component;
    },
    {
      overlay: true,
      overlayOptions: () => monitorOverlayOptions(terminalWidth, terminalRows, "intake"),
    },
  );
}

export function monitorOverlayOptions(
  terminalWidth: number,
  _terminalRows: number,
  kind: "runs" | "intake",
): OverlayOptions {
  const narrow = terminalWidth < 88;
  return {
    width: narrow ? "94%" : kind === "intake" ? "82%" : "72%",
    minWidth: Math.min(44, Math.max(24, terminalWidth - 4)),
    maxHeight: kind === "intake" ? "90%" : "80%",
    anchor: narrow ? "center" : "right-center",
    margin: 1,
  };
}
