import type { Component, OverlayOptions } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { MonitorController, MonitorControllerSnapshot } from "../src/monitor/controller.js";
import {
  PiMonitorBinding,
  monitorOverlayOptions,
  notifyPiMonitor,
  openPiGuidedRunModal,
  openPiRunsOverlay,
  piMonitorHostFromUi,
  type PiMonitorHostAdapter,
} from "../src/monitor/pi-host.js";
import { createGuidedRunState } from "../src/monitor/run-intake.js";
import { monitorModelsFixture, monitorRunTypesFixture } from "./fixtures/monitor-fixtures.js";

describe("Pi 0.80.10 host adapter boundary", () => {
  it("uses a keyed above-editor widget and additive status, then clears both idempotently", () => {
    const controller = new FakeBindingController();
    const host = new FakeHost();
    const binding = new PiMonitorBinding({
      controller: controller as unknown as MonitorController,
      host,
    });
    expect(host.widgets.at(-1)).toMatchObject({
      key: "koni.monitor",
      options: { placement: "aboveEditor" },
    });
    expect(typeof host.widgets.at(-1)?.content).toBe("function");
    expect(host.statuses.at(-1)).toEqual({ key: "koni.monitor", text: "Koni · stopped" });

    controller.publish({ ...controller.snapshot, connection: "suspended" });
    expect(host.widgets.at(-1)?.content).toBeUndefined();
    expect(host.statuses.at(-1)?.text).toBeUndefined();
    controller.publish({
      ...controller.snapshot,
      connection: "connected",
      monitor: {
        protocol: "koni.monitor-snapshot.v1",
        revision: 1,
        eventCursor: 0,
        totalRuns: 0,
        truncated: false,
        runs: [],
      },
    });
    expect(typeof host.widgets.at(-1)?.content).toBe("function");
    expect(host.statuses.at(-1)?.text).toBe("Koni · no runs");
    binding.dispose();
    binding.dispose();
    expect(host.widgets.at(-1)?.content).toBeUndefined();
    expect(host.statuses.at(-1)?.text).toBeUndefined();
  });

  it("maps notices to Pi visual notifications without sending a chat message", () => {
    const host = new FakeHost();
    notifyPiMonitor(host, {
      kind: "warning",
      message: "Koni needs input: 1 question",
      keys: ["question:r:q"],
    });
    expect(host.notifications).toEqual([
      { message: "Koni needs input: 1 question", type: "warning" },
    ]);
    expect(Object.keys(host)).not.toContain("sendMessage");
  });

  it("selects responsive short-lived overlay geometry", () => {
    expect(monitorOverlayOptions(60, 30, "runs")).toMatchObject({
      width: "94%",
      anchor: "center",
      maxHeight: "80%",
    });
    expect(monitorOverlayOptions(140, 50, "runs")).toMatchObject({
      width: "72%",
      anchor: "right-center",
      maxHeight: "80%",
    });
    expect(monitorOverlayOptions(140, 50, "intake")).toMatchObject({
      width: "82%",
      anchor: "right-center",
      maxHeight: "90%",
    });
  });

  it("delegates only exact Pi 0.80.10 UI primitives and mounts short-lived custom overlays", async () => {
    const setWidget = vi.fn();
    const setStatus = vi.fn();
    const notify = vi.fn();
    const custom = vi.fn(async (factory: any, options: any) => {
      let result: unknown;
      const tui = { terminal: { columns: 120, rows: 44 }, requestRender: vi.fn() };
      const theme = fakeTheme();
      const component = await factory(tui, theme, {}, (value: unknown) => {
        result = value;
      });
      expect(options.overlay).toBe(true);
      expect(options.overlayOptions()).toMatchObject({ anchor: "right-center" });
      component.handleInput("\x1b");
      component.dispose?.();
      return result;
    });
    const host = piMonitorHostFromUi({ setWidget, setStatus, notify, custom } as any);
    host.setStatus("koni.monitor", "Koni · no runs");
    host.notify("Ready", "info");
    expect(setStatus).toHaveBeenCalledWith("koni.monitor", "Koni · no runs");
    expect(notify).toHaveBeenCalledWith("Ready", "info");

    const controller = new FakeBindingController();
    const runsResult = await openPiRunsOverlay({
      host,
      controller: controller as unknown as MonitorController,
    });
    expect(runsResult).toEqual({ kind: "close" });
    const intakeResult = await openPiGuidedRunModal({
      host,
      state: createGuidedRunState({
        runTypes: monitorRunTypesFixture(),
        defaultRunTypeId: "medium",
        branches: [{ label: "main", reference: "refs/heads/main" }],
        models: monitorModelsFixture(),
      }),
      create: async () => ({ runId: "run-modal" }),
    });
    expect(intakeResult).toEqual({ kind: "cancel" });
    expect(custom).toHaveBeenCalledTimes(2);
    expect(setWidget).not.toHaveBeenCalled();
  });
});

class FakeHost implements PiMonitorHostAdapter {
  public readonly widgets: Array<{ key: string; content: unknown; options: unknown }> = [];
  public readonly statuses: Array<{ key: string; text: string | undefined }> = [];
  public readonly notifications: Array<{ message: string; type: string | undefined }> = [];

  public setWidget(key: string, content: any, options?: any): void {
    this.widgets.push({ key, content, options });
  }

  public setStatus(key: string, text: string | undefined): void {
    this.statuses.push({ key, text });
  }

  public notify(message: string, type?: "info" | "warning" | "error"): void {
    this.notifications.push({ message, type });
  }

  public async custom<T>(
    _factory: (...args: any[]) => Component,
    _options?: { overlay?: boolean; overlayOptions?: OverlayOptions | (() => OverlayOptions) },
  ): Promise<T> {
    throw new Error("not used");
  }
}

class FakeBindingController {
  readonly #listeners = new Set<(snapshot: MonitorControllerSnapshot) => void>();
  #snapshot: MonitorControllerSnapshot = {
    eligibility: { trusted: true, initialized: true },
    connection: "stopped",
    monitor: undefined,
    attentions: {},
    selectedRunId: undefined,
    eventCursor: 0,
    recentEvents: [],
    lastError: undefined,
    busy: false,
  };

  public get snapshot(): MonitorControllerSnapshot {
    return structuredClone(this.#snapshot);
  }

  public subscribe(listener: (snapshot: MonitorControllerSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public publish(snapshot: MonitorControllerSnapshot): void {
    this.#snapshot = structuredClone(snapshot);
    for (const listener of this.#listeners) listener(this.snapshot);
  }
}

function fakeTheme() {
  const identity = (_color: string, value: string) => value;
  return {
    fg: identity,
    bg: identity,
    bold: (value: string) => value,
  };
}
