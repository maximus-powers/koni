import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createKoniCoreExtension } from "../src/extension.js";

describe("installed Pi companion integration", () => {
  it("autostarts the authority and attaches read-only on trusted initialized startup, cleaning every passive surface on shutdown", async () => {
    const harness = extensionHarness();
    const connectMonitor = vi.fn(async () => undefined);
    const connectRunIntake = vi.fn();
    const loadModels = vi.fn(async () => []);
    const close = vi.fn();
    const ensure = vi.fn(async () => ({ close }));
    createKoniCoreExtension({
      assertCoreRuntime: vi.fn(async () => undefined),
      assertPiHost: vi.fn(async () => undefined),
      inspect: vi.fn(async () => initializedInspection()),
      connectMonitor,
      connectRunIntake,
      loadModels,
      ensure,
    })(harness.pi);

    const context = companionContext(harness);
    await harness.handlers.get("session_start")!(
      { type: "session_start", reason: "startup" },
      context,
    );

    expect(ensure).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(connectMonitor).toHaveBeenCalledOnce();
    expect(connectRunIntake).not.toHaveBeenCalled();
    expect(loadModels).not.toHaveBeenCalled();
    expect(harness.widgets.some((entry) => entry.content !== undefined)).toBe(true);
    expect(harness.statuses.some((entry) => entry.text?.includes("Koni") === true)).toBe(true);

    await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, context);
    expect(harness.widgets.at(-1)).toMatchObject({ key: "koni.monitor", content: undefined });
    expect(harness.statuses.at(-1)).toEqual({ key: "koni.monitor", text: undefined });
  });

  it("skips autostart when KONI_AUTOSTART=0 while still attaching the passive monitor", async () => {
    const harness = extensionHarness();
    const connectMonitor = vi.fn(async () => undefined);
    const ensure = vi.fn();
    createKoniCoreExtension({
      inspect: vi.fn(async () => initializedInspection()),
      connectMonitor,
      ensure,
    })(harness.pi);

    process.env.KONI_AUTOSTART = "0";
    try {
      await harness.handlers.get("session_start")!(
        { type: "session_start", reason: "startup" },
        companionContext(harness),
      );
    } finally {
      delete process.env.KONI_AUTOSTART;
    }

    expect(ensure).not.toHaveBeenCalled();
    expect(connectMonitor).toHaveBeenCalledOnce();
  });

  it("keeps the session healthy and the monitor attached when autostart fails", async () => {
    const harness = extensionHarness();
    const connectMonitor = vi.fn(async () => undefined);
    const ensure = vi.fn(async () => {
      throw new Error("authority start timeout");
    });
    createKoniCoreExtension({
      inspect: vi.fn(async () => initializedInspection()),
      connectMonitor,
      ensure,
    })(harness.pi);

    await harness.handlers.get("session_start")!(
      { type: "session_start", reason: "startup" },
      companionContext(harness),
    );

    expect(ensure).toHaveBeenCalledOnce();
    expect(connectMonitor).toHaveBeenCalledOnce();
    expect(harness.notifications).toEqual([
      expect.objectContaining({
        type: "warning",
        message: expect.stringContaining("authority start timeout"),
      }),
    ]);
  });

  it("never restarts the authority as a side effect of an explicit stop", async () => {
    const harness = extensionHarness();
    const connectMonitor = vi.fn(async () => undefined);
    const ensure = vi.fn();
    const stop = vi.fn(async () => ({
      wasRunning: true,
      projectRoot: "/project",
      pausedRunCount: 1,
      pausedRunIds: ["run-1"],
      pausedRunIdsTruncated: false,
    }));
    createKoniCoreExtension({
      assertCoreRuntime: vi.fn(async () => undefined),
      assertPiHost: vi.fn(async () => undefined),
      inspect: vi.fn(async () => initializedInspection()),
      connectMonitor,
      ensure,
      stop,
    })(harness.pi);

    await harness.commands.get("koni")!.handler("stop", companionContext(harness));

    expect(stop).toHaveBeenCalledOnce();
    expect(ensure).not.toHaveBeenCalled();
    expect(connectMonitor).toHaveBeenCalledOnce();
    expect(harness.notifications[0]?.message).toBe(
      "Koni authority stopped. 1 active run(s) were paused.",
    );
  });

  it("registers the two native commands and gives exact init guidance without connecting or loading models", async () => {
    const harness = extensionHarness();
    const connectRunIntake = vi.fn();
    const loadModels = vi.fn(async () => []);
    createKoniCoreExtension({
      assertCoreRuntime: vi.fn(async () => undefined),
      assertPiHost: vi.fn(async () => undefined),
      inspect: vi.fn(async () => uninitializedInspection()),
      connectRunIntake,
      loadModels,
    })(harness.pi);

    expect([...harness.commands.keys()].sort()).toEqual(["koni", "koni-run", "koni-runs"]);
    await harness.commands.get("koni-run")!.handler("large", companionContext(harness));

    expect(connectRunIntake).not.toHaveBeenCalled();
    expect(loadModels).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual([
      {
        message:
          "Koni is not initialized in this repository. Run `/koni init coding` or `/koni init research`, then retry `/koni-run`.",
        type: "info",
      },
    ]);
  });

  it("treats the three intentional command names as one Core origin", async () => {
    const harness = extensionHarness(true);
    const openControlCenter = vi.fn(async () => undefined);
    createKoniCoreExtension({
      assertCoreRuntime: vi.fn(async () => undefined),
      assertPiHost: vi.fn(async () => undefined),
      openControlCenter,
    })(harness.pi);

    await harness.commands.get("koni")!.handler("", companionContext(harness));

    expect(openControlCenter).toHaveBeenCalledOnce();
    expect(harness.notifications).toEqual([]);
  });

  it("reattaches the read-only companion immediately after an explicit authority start", async () => {
    const harness = extensionHarness();
    const close = vi.fn();
    const ensure = vi.fn(async () => ({ close }));
    const connectMonitor = vi.fn(async () => undefined);
    createKoniCoreExtension({
      assertCoreRuntime: vi.fn(async () => undefined),
      assertPiHost: vi.fn(async () => undefined),
      ensure,
      inspect: vi.fn(async () => initializedInspection()),
      connectMonitor,
    })(harness.pi);

    await harness.commands.get("koni")!.handler("start", companionContext(harness));

    expect(ensure).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(connectMonitor).toHaveBeenCalledOnce();
    expect(harness.notifications[0]?.message).toBe(
      "Koni authority is running for this repository.",
    );
  });

  it("does not attach, inspect, autostart, or create UI in an untrusted ordinary Pi session", async () => {
    const harness = extensionHarness();
    const inspect = vi.fn(async () => initializedInspection());
    const connectMonitor = vi.fn(async () => undefined);
    const ensure = vi.fn();
    createKoniCoreExtension({ inspect, connectMonitor, ensure })(harness.pi);
    const context = companionContext(harness, false);

    await harness.handlers.get("session_start")!(
      { type: "session_start", reason: "startup" },
      context,
    );

    expect(inspect).not.toHaveBeenCalled();
    expect(connectMonitor).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(harness.widgets).toEqual([]);
    expect(harness.statuses).toEqual([]);
    expect(harness.notifications).toEqual([]);
  });
});

function extensionHarness(exposeCommands = false): {
  pi: ExtensionAPI;
  commands: Map<string, { handler(args: string, context: ExtensionCommandContext): Promise<void> }>;
  handlers: Map<string, (...args: any[]) => unknown>;
  widgets: Array<{ key: string; content: unknown }>;
  statuses: Array<{ key: string; text: string | undefined }>;
  notifications: Array<{ message: string; type: string | undefined }>;
} {
  const commands = new Map<
    string,
    { handler(args: string, context: ExtensionCommandContext): Promise<void> }
  >();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const eventListeners = new Map<string, Set<(value: unknown) => void>>();
  const widgets: Array<{ key: string; content: unknown }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const pi = {
    events: {
      on(topic: string, listener: (value: unknown) => void) {
        const listeners = eventListeners.get(topic) ?? new Set();
        listeners.add(listener);
        eventListeners.set(topic, listeners);
        return () => listeners.delete(listener);
      },
      emit(topic: string, value: unknown) {
        for (const listener of eventListeners.get(topic) ?? []) listener(value);
      },
    },
    registerCommand(name: string, command: unknown) {
      commands.set(
        name,
        command as { handler(args: string, context: ExtensionCommandContext): Promise<void> },
      );
    },
    registerShortcut() {},
    registerTool() {},
    ...(exposeCommands
      ? {
          getCommands() {
            return [...commands.keys()].map((name) => ({
              name,
              source: "extension",
              sourceInfo: {
                path: "/koni/extension.js",
                source: "npm:@koni/core",
                scope: "user",
                origin: "package",
              },
            }));
          },
        }
      : {}),
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return { pi, commands, handlers, widgets, statuses, notifications };
}

function companionContext(
  harness: ReturnType<typeof extensionHarness>,
  trusted = true,
): ExtensionContext & ExtensionCommandContext {
  return {
    cwd: "/project",
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => trusted,
    ui: {
      setWidget(key: string, content: unknown) {
        harness.widgets.push({ key, content });
      },
      setStatus(key: string, text: string | undefined) {
        harness.statuses.push({ key, text });
      },
      notify(message: string, type?: string) {
        harness.notifications.push({ message, type });
      },
      async custom<T>(): Promise<T> {
        return { kind: "close" } as T;
      },
    },
  } as unknown as ExtensionContext & ExtensionCommandContext;
}

function initializedInspection() {
  return {
    running: false,
    projectRoot: "/project",
    commonDirectory: "/project/.git",
    stateRoot: "/project/.git/koni",
    endpoint: "/tmp/koni.sock",
    profile: {
      packageName: "@koni/coding-profile",
      profileId: "software",
      profileVersion: "1.0.0",
      bundleSha256: `sha256:${"a".repeat(64)}`,
    },
  };
}

function uninitializedInspection() {
  return {
    running: false,
    projectRoot: "/project",
    commonDirectory: "/project/.git",
    stateRoot: "/project/.git/koni",
    endpoint: "/tmp/koni.sock",
  };
}
