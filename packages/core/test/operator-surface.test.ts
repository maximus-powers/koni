import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isDirectInvocation,
  runKoniCli,
  type KoniCliDependencies,
  type KoniCliIO,
} from "../src/cli.js";
import { createKoniCoreExtension } from "../src/extension.js";
import { AuthorityServer } from "../src/authority/server.js";
import {
  createProjectRun,
  ensureProjectAuthority,
  launchAuthorityDaemon,
  proposalTicketForOperatorDecision,
  serveProjectAuthority,
  stopAuthorityWhenInstallationSuperseded,
} from "../src/operator/authority-bootstrap.js";
import { authorityDaemonEnvironment } from "../src/operator/authority-daemon-environment.js";
import type { RunRecord } from "../src/state/run-record.js";
import { createRunFromPi, projectPiModels } from "../src/operator/control-center-host.js";
import {
  installAndCacheProfile,
  loadCachedInstalledProfile,
  PiProfileSourceCatalog,
} from "../src/operator/profile-source.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("provider-free authority launch containment", () => {
  it("self-seals the detached authority environment after resource resolution", () => {
    const environment = authorityDaemonEnvironment(
      { KONI_PI_PACKAGE_ROOT: "/exact/pi/runtime" },
      true,
    );

    expect(environment).toMatchObject({
      KONI_PI_PACKAGE_ROOT: "/exact/pi/runtime",
      KONI_PROVIDER_FREE_RELEASE_PROBE: "1",
      NODE_ENV: "test",
      PI_OFFLINE: "1",
    });
  });
});

describe("Pi operator extension", () => {
  it("projects the contained runtime catalog and disables ambient-only Pi providers", async () => {
    const native = { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol", reasoning: true };
    const extensionOnly = {
      provider: "community",
      id: "custom",
      name: "Community Custom",
      reasoning: true,
    };
    const getAll = vi.fn(() => [native, extensionOnly]);
    const getAvailable = vi.fn(() => [native, extensionOnly]);
    const getRegisteredProviderIds = vi.fn(() => ["community"]);
    const runtime = {
      getModels: vi.fn(() => [native]),
      getAvailableSnapshot: vi.fn(() => [native]),
    };
    const models = await projectPiModels(
      {
        modelRegistry: { getAll, getAvailable, getRegisteredProviderIds } as never,
      },
      { runtime },
    );
    expect(models).toEqual([
      { ...native, thinkingLevels: ["off", "minimal", "low", "medium", "high"], available: true },
      {
        ...extensionOnly,
        thinkingLevels: ["off", "minimal", "low", "medium", "high"] as const,
        available: false,
        unavailableReason:
          "This provider comes from an ambient Pi extension; contained Koni attempts do not load ambient extensions.",
      },
    ]);
    expect(getAll).toHaveBeenCalledOnce();
    expect(getAvailable).not.toHaveBeenCalled();
    expect(getRegisteredProviderIds).toHaveBeenCalledOnce();
  });

  it("is inert until /koni is invoked and mounts the shared control-center host on demand", async () => {
    const extensionHandlers = new Map<string, (...arguments_: any[]) => unknown>();
    const eventHandlers = new Map<string, (payload: unknown) => void>();
    const commands = new Map<
      string,
      { handler(args: string, context: ExtensionCommandContext): Promise<void> }
    >();
    const open = vi.fn(async () => undefined);
    const pi = {
      events: {
        on(channel: string, handler: (payload: unknown) => void) {
          eventHandlers.set(channel, handler);
          return () => eventHandlers.delete(channel);
        },
        emit(channel: string, payload: unknown) {
          eventHandlers.get(channel)?.(payload);
        },
      },
      registerCommand(name: string, command: unknown) {
        commands.set(
          name,
          command as { handler(args: string, context: ExtensionCommandContext): Promise<void> },
        );
      },
      registerTool() {},
      on(event: string, handler: (...arguments_: any[]) => unknown) {
        extensionHandlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;

    createKoniCoreExtension({
      assertPiHost: vi.fn(async () => undefined),
      openControlCenter: open,
    })(pi);
    expect(commands.has("koni")).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect([...extensionHandlers.keys()]).toEqual(["session_start", "session_shutdown"]);

    await commands.get("koni")!.handler("", fakeCommandContext());
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/project" }));
  });

  it("answers status without starting an authority", async () => {
    const { pi, commands, notifications } = fakePi();
    const ensure = vi.fn(async () => ({ close() {} }));
    createKoniCoreExtension({
      assertPiHost: vi.fn(async () => undefined),
      ensure,
      inspect: async () => ({
        running: false,
        projectRoot: "/project",
        commonDirectory: "/project/.git",
        stateRoot: "/project/.git/koni",
        endpoint: "/tmp/koni.sock",
        profile: {
          packageName: "@koni/coding-profile",
          profileId: "software",
          profileVersion: "0.6.0",
          bundleSha256: `sha256:${"a".repeat(64)}`,
        },
      }),
    })(pi);
    await commands.get("koni")!.handler("status", fakeCommandContext(notifications));
    expect(ensure).not.toHaveBeenCalled();
    expect(notifications[0]?.message).toContain("Koni stopped");
  });

  it("makes every loaded Core instance fail closed when Pi has duplicate origins", async () => {
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    const events = {
      on(topic: string, handler: (payload: unknown) => void) {
        const listeners = handlers.get(topic) ?? new Set();
        listeners.add(handler);
        handlers.set(topic, listeners);
        return () => listeners.delete(handler);
      },
      emit(topic: string, payload: unknown) {
        for (const listener of [...(handlers.get(topic) ?? [])]) listener(payload);
      },
    };
    const first = fakePiWithEvents(events);
    const second = fakePiWithEvents(events);
    const firstOpen = vi.fn(async () => undefined);
    const secondOpen = vi.fn(async () => undefined);
    createKoniCoreExtension({
      assertPiHost: vi.fn(async () => undefined),
      openControlCenter: firstOpen,
    })(first.pi);
    createKoniCoreExtension({
      assertPiHost: vi.fn(async () => undefined),
      openControlCenter: secondOpen,
    })(second.pi);

    await first.commands.get("koni")!.handler("", fakeCommandContext(first.notifications));
    await second.commands.get("koni")!.handler("", fakeCommandContext(second.notifications));
    expect(firstOpen).not.toHaveBeenCalled();
    expect(secondOpen).not.toHaveBeenCalled();
    for (const notification of [...first.notifications, ...second.notifications]) {
      expect(notification.message).toContain("multiple @koni/core extensions");
      expect(notification.message).toContain("pi list");
      expect(notification.message).toContain("pi remove <older-koni-source> --local");
      expect(notification.message).toContain("/reload");
    }
  });

  it("warns about a legacy duplicate without shutting down the ordinary Pi session", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const notifications: Array<{ message: string; type: string | undefined }> = [];
    const shutdown = vi.fn();
    const pi = {
      events: {
        on() {
          return () => undefined;
        },
        emit() {},
      },
      registerCommand() {},
      registerTool() {},
      getCommands: () => [
        {
          name: "koni:1",
          source: "extension",
          sourceInfo: {
            path: "/global/legacy.js",
            source: "npm:@koni/core@0.9.0",
            scope: "user",
            origin: "package",
          },
        },
        {
          name: "koni:2",
          source: "extension",
          sourceInfo: {
            path: "/project/current.js",
            source: "../koni",
            scope: "project",
            origin: "package",
          },
        },
      ],
      on(event: string, handler: (...args: any[]) => unknown) {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;
    createKoniCoreExtension()(pi);
    const context = {
      ...fakeCommandContext(notifications),
      shutdown,
    } as unknown as ExtensionCommandContext;

    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, context);
    expect(shutdown).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("warning");
    expect(notifications[0]?.message).toContain("Ordinary Pi use remains available");
    expect(notifications[0]?.message).toContain("pi remove 'npm:@koni/core@0.9.0'`");
    expect(notifications[0]?.message).not.toContain("npm:@koni/core@0.9.0' --local");
    expect(notifications[0]?.message).toContain("pi remove '../koni' --local");
  });

  it("defers Pi-host checks until a Koni command and never shuts down Pi on incompatibility", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const commands = new Map<
      string,
      { handler(args: string, context: ExtensionCommandContext): Promise<void> }
    >();
    const notifications: Array<{ message: string; type: string | undefined }> = [];
    const shutdown = vi.fn();
    const open = vi.fn(async () => undefined);
    const assertPiHost = vi.fn(async () => {
      throw new Error("Pi 0.80.11 is unsupported");
    });
    const pi = {
      events: {
        on() {
          return () => undefined;
        },
        emit() {},
      },
      registerCommand(name: string, command: unknown) {
        commands.set(
          name,
          command as { handler(args: string, context: ExtensionCommandContext): Promise<void> },
        );
      },
      registerTool() {},
      getCommands: () => [
        {
          name: "koni",
          source: "extension",
          sourceInfo: {
            path: "/koni/extension.js",
            source: "npm:@koni/core",
            scope: "user",
            origin: "package",
          },
        },
      ],
      on(event: string, handler: (...args: any[]) => unknown) {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;
    createKoniCoreExtension({
      assertPiHost,
      openControlCenter: open,
    })(pi);
    const context = {
      ...fakeCommandContext(notifications),
      shutdown,
    } as unknown as ExtensionCommandContext;

    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, context);

    expect(assertPiHost).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(notifications).toEqual([]);

    await commands.get("koni")!.handler("", context);
    expect(assertPiHost).toHaveBeenCalledOnce();
    expect(shutdown).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(notifications).toEqual([
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Pi 0.80.11 is unsupported"),
      }),
    ]);
  });

  it("shows both conflict documents before asking Pi users to keep or use an update", async () => {
    const { pi, commands } = fakePi();
    const ordering: string[] = [];
    const conflict = {
      path: "resources/pi-packages.yaml",
      title: "Pi Packages",
      domain: "resources",
      reason: "modified",
      currentSha256: `sha256:${"c".repeat(64)}`,
      upstreamSha256: `sha256:${"d".repeat(64)}`,
    };
    const client = {
      revision: 13,
      request: vi.fn(async (method: string, params?: unknown, options?: unknown) => {
        ordering.push(`rpc:${method}`);
        if (method === "profile.conflicts.list")
          return {
            result: {
              protocol: "koni.profile-upstream-conflict-catalog.v1",
              lifecycleGeneration: 4,
              profileVersion: "1.0.0",
              conflicts: [conflict],
            },
          };
        if (method === "profile.conflicts.inspect")
          return {
            result: {
              protocol: "koni.profile-upstream-conflict-inspection.v1",
              lifecycleGeneration: 4,
              conflict,
              currentText: "packages:\n  - project-tool\n",
              upstreamText: "packages:\n  - upstream-tool\n",
            },
          };
        if (method === "profile.conflicts.resolve") {
          expect(params).toEqual({
            path: conflict.path,
            expectedLifecycleGeneration: 4,
            expectedProjectSha256: conflict.currentSha256,
            resolution: "accept_upstream",
          });
          expect(options).toMatchObject({ expectedRevision: 13 });
          return { result: { resolved: true } };
        }
        throw new Error(`unexpected RPC ${method}`);
      }),
      close: vi.fn(),
    };
    createKoniCoreExtension({
      assertPiHost: vi.fn(async () => undefined),
      ensure: vi.fn(async () => client as never),
    })(pi);
    const context = {
      cwd: "/project",
      mode: "tui",
      hasUI: true,
      ui: {
        notify(message: string) {
          ordering.push(`notify:${message}`);
        },
        async select(title: string, choices: string[]) {
          ordering.push(`select:${title}:${choices.join("|")}`);
          return "Use upstream update";
        },
      },
    } as unknown as ExtensionCommandContext;

    await commands.get("koni")!.handler("conflicts resources/pi-packages.yaml", context);
    const comparisonIndex = ordering.findIndex(
      (entry) =>
        entry.startsWith("notify:Project:\npackages:\n  - project-tool") &&
        entry.includes("Upstream:\npackages:\n  - upstream-tool"),
    );
    const choiceIndex = ordering.findIndex((entry) =>
      entry.startsWith("select:Pi Packages · modified:"),
    );
    expect(comparisonIndex).toBeGreaterThan(-1);
    expect(choiceIndex).toBeGreaterThan(comparisonIndex);
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "profile.conflicts.list",
      "profile.conflicts.inspect",
      "profile.conflicts.resolve",
    ]);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("blocks an unavailable interactive default before branch lookup or run.create", async () => {
    const calls: string[] = [];
    const client = {
      revision: 4,
      request: vi.fn(async (method: string) => {
        calls.push(method);
        if (method === "control.catalog") return { result: modelAdmissionCatalog() };
        throw new Error(`unexpected RPC ${method}`);
      }),
      close: vi.fn(),
    };
    const context = {
      ...fakeCommandContext(),
      modelRegistry: {},
      ui: {
        notify() {},
        editor: vi.fn(async () => "Build notes"),
        select: vi.fn(async () => "small"),
      },
    } as unknown as ExtensionCommandContext;

    await expect(
      createRunFromPi(
        { context, version: "1.0.0" },
        {
          ensure: vi.fn(async () => client as never),
          loadModels: vi.fn(async () => [
            {
              provider: "openai-codex",
              id: "gpt-small",
              name: "GPT Small",
              reasoning: true,
              thinkingLevels: ["off", "minimal", "low", "medium", "high"] as const,
              available: false,
              unavailableReason: "No Pi credential is configured.",
            },
          ]),
        },
      ),
    ).rejects.toThrow(/No Pi credential is configured/);
    expect(calls).toEqual(["control.catalog"]);
    expect(client.close).toHaveBeenCalledOnce();
  });
});

describe("shell operator surface", () => {
  it("allows explicit audit steering for an already-approved proposal", () => {
    const approved = {
      id: "TK-change-approved",
      title: "Approved bounded repair",
      status: "running",
      executionControl: {
        proposalRequest: { requestSha256: `sha256:${"a".repeat(64)}` },
        proposalDecision: { decision: "approval" },
        proposalApprovalSha256: `sha256:${"c".repeat(64)}`,
      },
    };
    const pending = {
      id: "TK-change-pending",
      title: "Pending bounded repair",
      status: "proposed",
      executionControl: {
        proposalRequest: { requestSha256: `sha256:${"b".repeat(64)}` },
      },
    };
    const run = {
      id: "run-1",
      tickets: { [approved.id]: approved, [pending.id]: pending },
    } as unknown as RunRecord;

    expect(proposalTicketForOperatorDecision(run, approved.id)).toBe(approved);
    expect(proposalTicketForOperatorDecision(run)).toBe(pending);
  });

  it("decides a held change proposal from the CLI and refuses an ambiguous decision", async () => {
    const output: string[] = [];
    const io: KoniCliIO = {
      stdout: (text) => output.push(text),
      stderr: () => undefined,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    };
    const dependencies = fakeCliDependencies();
    vi.mocked(dependencies.decideProposal).mockResolvedValue({
      runId: "run-1",
      ticketId: "TK-change-1",
      decision: "approval",
    });

    expect(
      await runKoniCli(
        ["decide", "--run", "run-1", "--approve", "--root", "/project"],
        io,
        dependencies,
      ),
    ).toBe(0);
    expect(dependencies.decideProposal).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", decision: "approval" }),
    );
    expect(output.join("")).toContain("TK-change-1");

    // A proposal decision is not a retry: an operator who supplies neither or both intents must be
    // told rather than silently defaulted into approving an upstream change.
    await expect(runKoniCli(["decide", "--run", "run-1"], io, dependencies)).rejects.toThrow(
      /--approve or --reject/u,
    );
    await expect(
      runKoniCli(["decide", "--run", "run-1", "--approve", "--reject"], io, dependencies),
    ).rejects.toThrow(/not both/u);
  });

  it("provides deterministic help/version/status without launching a TUI or daemon", async () => {
    const output: string[] = [];
    const io: KoniCliIO = {
      stdout: (text) => output.push(text),
      stderr: () => undefined,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    };
    const dependencies = fakeCliDependencies();
    expect(await runKoniCli(["--version"], io, dependencies)).toBe(0);
    expect(output.pop()).toBe("1.0.0\n");
    expect(await runKoniCli(["--help"], io, dependencies)).toBe(0);
    const help = output.pop()!;
    expect(help).toContain("koni run --goal TEXT [--field ID=VALUE]... [--type <run-type>]");
    expect(help).toContain(
      "Available run types come from the project's compiled profile and configuration.",
    );
    // Run types may require intake beyond the objective, and a started run has to be advanceable
    // without the TUI; both are headless-operator entry points.
    expect(help).toContain("--field answers additional required intake");
    expect(help).toContain("koni approve --run RUN_ID");
    expect(help).not.toContain("--type small|medium|large");
    expect(await runKoniCli(["status", "--json"], io, dependencies)).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject({ running: false, projectRoot: "/project" });
    expect(dependencies.ensure).not.toHaveBeenCalled();
    expect(dependencies.standalone).not.toHaveBeenCalled();
  });

  it("resolves one Pi-native agent through the config CLI", async () => {
    const output: string[] = [];
    const io: KoniCliIO = {
      stdout: (text) => output.push(text),
      stderr: () => undefined,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    };
    const dependencies = fakeCliDependencies();
    vi.mocked(dependencies.resolveAgent).mockResolvedValue({
      projectRoot: "/project",
      runTypeId: "small",
      agent: {
        agentId: "run-planner",
        ancestry: ["base", "run-planner"],
        description: "",
        instructions: "Plan.",
        settings: {},
        resources: { skills: [], extensions: [], prompts: [], themes: [], context: [] },
        extensions: [],
        tools: [{ name: "read" }],
        koni: { role: "planner", capabilities: {} },
        configurationSha256: `sha256:${"a".repeat(64)}`,
      },
      effectiveModel: { provider: "openai-codex", id: "gpt-5.6-terra", thinkingLevel: "high" },
    });

    expect(
      await runKoniCli(
        ["config", "resolve-agent", "run-planner", "--run-type", "small", "--json"],
        io,
        dependencies,
      ),
    ).toBe(0);
    expect(dependencies.resolveAgent).toHaveBeenCalledWith({
      projectRoot: expect.any(String),
      agentId: "run-planner",
      runTypeId: "small",
    });
    expect(JSON.parse(output[0]!)).toMatchObject({ agent: { agentId: "run-planner" } });
  });

  it("opens the shared standalone control center only from an explicit interactive TUI command", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "koni-cli-tui-"));
    temporaryRoots.push(root);
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    const projectRoot = await realpath(root);
    const io: KoniCliIO = {
      stdout: () => undefined,
      stderr: () => undefined,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    };
    const dependencies = fakeCliDependencies();
    const close = vi.fn();
    const client = { close };
    vi.mocked(dependencies.ensure).mockResolvedValue(client as never);

    expect(await runKoniCli(["tui", "--root", projectRoot], io, dependencies)).toBe(0);
    expect(dependencies.ensure).toHaveBeenCalledWith({
      projectRoot,
      version: "1.0.0",
      client: "tui",
    });
    expect(dependencies.standalone).toHaveBeenCalledWith({
      projectRoot,
      version: "1.0.0",
      client,
      reconnectClient: expect.any(Function),
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("stops the running authority after updating so the change takes effect on next use", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "koni-cli-update-"));
    temporaryRoots.push(root);
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    const projectRoot = await realpath(root);
    const output: string[] = [];
    const io: KoniCliIO = {
      stdout: (text) => output.push(text),
      stderr: () => undefined,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    };
    const dependencies = fakeCliDependencies();
    vi.mocked(dependencies.readInstalled).mockResolvedValue({
      packageName: "@koni/coding-profile",
      profileId: "software",
      profileVersion: "0.7.0",
      bundleSha256: `sha256:${"a".repeat(64)}`,
    });
    vi.mocked(dependencies.resolveProfile).mockResolvedValue("/authenticated/coding-profile");
    vi.mocked(dependencies.previewInstall).mockResolvedValue({
      profileVersion: "0.8.0",
      mandatoryRetirements: [],
      previewSha256: `sha256:${"b".repeat(64)}`,
    } as never);
    vi.mocked(dependencies.install).mockResolvedValue({
      packageName: "@koni/coding-profile",
      profileVersion: "0.8.0",
      added: [],
      updated: ["graph.yaml"],
      preserved: [],
      pendingUpstream: [],
    } as never);
    vi.mocked(dependencies.stop).mockResolvedValue({
      wasRunning: true,
      projectRoot,
      pausedRunCount: 2,
      pausedRunIds: ["run-a", "run-b"],
      pausedRunIdsTruncated: false,
    });

    expect(await runKoniCli(["update", "coding", "--root", root], io, dependencies)).toBe(0);
    expect(dependencies.stop).toHaveBeenCalledWith({ projectRoot, version: "1.0.0" });
    const printed = output.join("");
    expect(printed).toContain("Stopped the running authority");
    expect(printed).toContain("paused 2 active run");
  });

  it("uses the compiled default when --type is omitted and the profile has no small run type", async () => {
    const output: string[] = [];
    const io: KoniCliIO = {
      stdout: (text) => output.push(text),
      stderr: () => undefined,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    };
    const dependencies = fakeCliDependencies();
    const client = {
      revision: 4,
      request: vi.fn(async (method: string) => {
        if (method !== "control.catalog") throw new Error(`unexpected RPC ${method}`);
        return {
          result: {
            ...modelAdmissionCatalog(),
            defaultRunTypeId: "custom",
            runTypes: [{ ...modelAdmissionCatalog().runTypes[0]!, id: "custom", title: "Custom" }],
          },
        };
      }),
      close: vi.fn(),
    };
    vi.mocked(dependencies.ensure).mockResolvedValue(client as never);
    vi.mocked(dependencies.run).mockResolvedValue({ runId: "run-default", status: "starting" });

    expect(
      await runKoniCli(
        ["run", "--goal", "Build without small", "--target", "main", "--root", "/project"],
        io,
        dependencies,
      ),
    ).toBe(0);
    expect(dependencies.run).toHaveBeenCalledWith({
      projectRoot: "/project",
      version: "1.0.0",
      objective: "Build without small",
      runTypeId: "custom",
      targetRef: "main",
    });
    expect(output.at(-1)).toContain("Started custom run run-default on main.");
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("resumes a paused or blocked run by id", async () => {
    const output: string[] = [];
    const io: KoniCliIO = {
      stdout: (text) => output.push(text),
      stderr: () => undefined,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    };
    const dependencies = fakeCliDependencies();
    vi.mocked(dependencies.resumeRun).mockResolvedValue({
      runId: "run-successor",
      status: "draft",
    });

    expect(
      await runKoniCli(
        ["resume", "--run", "run-successor", "--root", "/project", "--json"],
        io,
        dependencies,
      ),
    ).toBe(0);
    expect(dependencies.resumeRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-successor" }),
    );
    expect(output.map((entry) => JSON.parse(entry))).toEqual([
      expect.objectContaining({ runId: "run-successor", status: "draft" }),
    ]);
  });

  it("lists, inspects, and resolves upstream profile conflicts through revisioned authority", async () => {
    const output: string[] = [];
    const io: KoniCliIO = {
      stdout: (text) => output.push(text),
      stderr: () => undefined,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    };
    const dependencies = fakeCliDependencies();
    const calls: Array<{ method: string; params?: unknown; options?: unknown }> = [];
    const conflict = {
      path: "resources/pi-packages.yaml",
      title: "Pi Packages",
      domain: "resources",
      reason: "modified",
      currentSha256: `sha256:${"c".repeat(64)}`,
      upstreamSha256: `sha256:${"d".repeat(64)}`,
    };
    const client = {
      revision: 11,
      request: vi.fn(async (method: string, params?: unknown, options?: unknown) => {
        calls.push({ method, params, options });
        if (method === "profile.conflicts.list")
          return {
            result: {
              protocol: "koni.profile-upstream-conflict-catalog.v1",
              lifecycleGeneration: 3,
              profileVersion: "1.0.0",
              conflicts: [conflict],
            },
          };
        if (method === "profile.conflicts.inspect")
          return {
            result: {
              protocol: "koni.profile-upstream-conflict-inspection.v1",
              lifecycleGeneration: 3,
              conflict,
              currentText: "packages:\n  - project-tool\n",
              upstreamText: "packages:\n  - upstream-tool\n",
            },
          };
        if (method === "profile.conflicts.resolve") return { result: { resolved: true } };
        throw new Error(`unexpected RPC ${method}`);
      }),
      close: vi.fn(),
    };
    vi.mocked(dependencies.ensure).mockResolvedValue(client as never);

    expect(await runKoniCli(["conflicts", "--root", "/project"], io, dependencies)).toBe(0);
    expect(output.at(-1)).toContain("resources/pi-packages.yaml · modified");
    expect(
      await runKoniCli(
        ["conflicts", "resources/pi-packages.yaml", "--root", "/project"],
        io,
        dependencies,
      ),
    ).toBe(0);
    expect(output.at(-1)).toContain("project-tool");
    expect(output.at(-1)).toContain("upstream-tool");
    expect(
      await runKoniCli(
        ["conflicts", "resources/pi-packages.yaml", "--accept-upstream", "--root", "/project"],
        io,
        dependencies,
      ),
    ).toBe(0);
    expect(calls.at(-1)).toMatchObject({
      method: "profile.conflicts.resolve",
      params: {
        path: conflict.path,
        expectedLifecycleGeneration: 3,
        expectedProjectSha256: conflict.currentSha256,
        resolution: "accept_upstream",
      },
      options: { expectedRevision: 11 },
    });
    expect((calls.at(-1)?.options as { idempotencyKey?: string }).idempotencyKey).toMatch(
      /^profile\.conflicts\.resolve:/u,
    );
    expect(client.close).toHaveBeenCalledTimes(3);
  });

  it("recognizes the npm-installed symlink as a direct executable invocation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "koni-cli-symlink-"));
    temporaryRoots.push(root);
    const modulePath = path.join(root, "package", "dist", "cli.js");
    const executablePath = path.join(root, "prefix", "bin", "koni");
    await mkdir(path.dirname(modulePath), { recursive: true });
    await mkdir(path.dirname(executablePath), { recursive: true });
    await writeFile(modulePath, "#!/usr/bin/env node\n", "utf8");
    await symlink(modulePath, executablePath);

    expect(isDirectInvocation(executablePath, modulePath)).toBe(true);
    expect(isDirectInvocation(path.join(root, "missing"), modulePath)).toBe(false);
  });

  it("blocks an unavailable CLI default before run.create", async () => {
    const calls: string[] = [];
    const client = {
      revision: 8,
      request: vi.fn(async (method: string) => {
        calls.push(method);
        if (method === "control.catalog") return { result: modelAdmissionCatalog() };
        throw new Error(`unexpected RPC ${method}`);
      }),
      close: vi.fn(),
    };

    await expect(
      createProjectRun(
        {
          projectRoot: "/project",
          version: "1.0.0",
          objective: "Build notes",
          runTypeId: "small",
          targetRef: "main",
        },
        {
          ensure: vi.fn(async () => client as never),
          loadModels: vi.fn(async () => [
            {
              provider: "openai-codex",
              id: "gpt-small",
              name: "GPT Small",
              reasoning: true,
              thinkingLevels: ["off", "minimal", "low", "medium", "high"] as const,
              available: false,
              unavailableReason: "No Pi credential is configured.",
            },
          ]),
        },
      ),
    ).rejects.toThrow(/No Pi credential is configured/);
    expect(calls).toEqual(["control.catalog"]);
    expect(client.close).toHaveBeenCalledOnce();
  });
});

describe("authenticated profile cache", () => {
  it("persists exact verified package bytes beneath the Git common directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "koni-operator-profile-"));
    temporaryRoots.push(root);
    const projectRoot = path.join(root, "project");
    await mkdir(projectRoot);
    await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
    const packageRoot = path.join(repositoryRoot, "packages", "coding-profile");

    const installed = await installAndCacheProfile({
      projectRoot,
      profilePackageRoot: packageRoot,
    });
    const cached = await loadCachedInstalledProfile(projectRoot);
    expect(cached.manifest.bundle_sha256).toBe(installed.bundleSha256);
    expect(cached.manifest.package.name).toBe("@koni/coding-profile");
    expect(cached.packageRoot).toContain(path.join(".git", "koni", "profile-cache"));
  }, 30_000);

  it("publishes only from the verified immutable cache after ambient package bytes disappear", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "koni-operator-profile-race-"));
    temporaryRoots.push(root);
    const projectRoot = path.join(root, "project");
    const sourceRoot = path.join(root, "ambient-profile");
    await mkdir(projectRoot);
    await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
    await execFileAsync("cp", [
      "-R",
      path.join(repositoryRoot, "packages", "coding-profile"),
      sourceRoot,
    ]);
    let installedFrom: string | undefined;
    const installed = await installAndCacheProfile(
      { projectRoot, profilePackageRoot: sourceRoot },
      {
        install: async (target, packageRoot) => {
          installedFrom = packageRoot;
          await rm(sourceRoot, { recursive: true, force: true });
          const { installProfile } = await import("../src/profile/install.js");
          return installProfile(target, packageRoot);
        },
      },
    );
    expect(installedFrom).toBe(installed.cachedPackageRoot);
    expect(installed.cachedPackageRoot).toContain(path.join(".git", "koni", "profile-cache"));
    expect(await loadCachedInstalledProfile(projectRoot)).toMatchObject({
      manifest: { bundle_sha256: installed.bundleSha256 },
    });
  }, 30_000);

  it("connects every interface to one authority lease for a nested project cwd", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "koni-operator-authority-"));
    temporaryRoots.push(root);
    const projectRoot = path.join(root, "project");
    const nested = path.join(projectRoot, "src", "nested");
    await mkdir(nested, { recursive: true });
    await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
    await installAndCacheProfile({
      projectRoot: nested,
      profilePackageRoot: path.join(repositoryRoot, "packages", "coding-profile"),
    });

    const server = new AuthorityServer({ projectRoot, version: "1.0.0" });
    server.register("project.status", {
      mutating: false,
      handle: () => ({ result: { projectRoot, version: "1.0.0", revision: 0, runCount: 0 } }),
    });
    const launch = vi.fn(async () => {
      await server.start();
      return {};
    });
    const first = await withAuthenticatedPiRuntime(() =>
      ensureProjectAuthority({
        projectRoot: nested,
        version: "1.0.0",
        client: "cli",
        launch,
        timeoutMs: 3_000,
      }),
    );
    const shouldNotLaunch = vi.fn(async () => ({}));
    const second = await withAuthenticatedPiRuntime(() =>
      ensureProjectAuthority({
        projectRoot,
        version: "1.0.0",
        client: "pi-extension",
        launch: shouldNotLaunch,
        timeoutMs: 3_000,
      }),
    );
    expect(launch).toHaveBeenCalledOnce();
    expect(shouldNotLaunch).not.toHaveBeenCalled();
    first.close();
    second.close();
    await server.stop();
  }, 30_000);

  it("refuses to launch an authority from a superseded versioned installation", async () => {
    const prefix = await realpath(await mkdtemp(path.join(tmpdir(), "koni-stale-launch-")));
    temporaryRoots.push(prefix);
    const firstLauncher = versionedLauncher(prefix, "bundle-a");
    const secondLauncher = versionedLauncher(prefix, "bundle-b");
    await Promise.all(
      [firstLauncher, secondLauncher].map(async (launcher) => {
        await mkdir(path.dirname(launcher), { recursive: true });
        await writeFile(launcher, "#!/usr/bin/env node\n", "utf8");
      }),
    );
    const activeLauncher = path.join(prefix, "bin", "koni");
    await mkdir(path.dirname(activeLauncher), { recursive: true });
    await symlink(secondLauncher, activeLauncher);

    await expect(
      launchAuthorityDaemon({
        projectRoot: "/authority-launch-must-not-reach-project-discovery",
        version: "1.0.0",
        activeInstallation: {
          activeLauncherPath: activeLauncher,
          expectedLauncherPath: firstLauncher,
        },
      }),
    ).rejects.toMatchObject({ code: "core_install_superseded" });
    await expect(
      serveProjectAuthority({
        projectRoot: "/authority-serve-must-not-reach-runtime-staging",
        version: "1.0.0",
        activeInstallation: {
          activeLauncherPath: activeLauncher,
          expectedLauncherPath: firstLauncher,
        },
      }),
    ).rejects.toMatchObject({ code: "core_install_superseded" });
  });

  it("routes an active installation change through the durable authority stop boundary", async () => {
    const prefix = await realpath(await mkdtemp(path.join(tmpdir(), "koni-upgrade-handoff-")));
    temporaryRoots.push(prefix);
    const firstLauncher = versionedLauncher(prefix, "bundle-a");
    const secondLauncher = versionedLauncher(prefix, "bundle-b");
    await Promise.all(
      [firstLauncher, secondLauncher].map(async (launcher) => {
        await mkdir(path.dirname(launcher), { recursive: true });
        await writeFile(launcher, "#!/usr/bin/env node\n", "utf8");
      }),
    );
    const activeLauncher = path.join(prefix, "bin", "koni");
    await mkdir(path.dirname(activeLauncher), { recursive: true });
    await symlink(firstLauncher, activeLauncher);

    const handoff = stopAuthorityWhenInstallationSuperseded(
      {
        binding: {
          activeLauncherPath: activeLauncher,
          expectedLauncherPath: firstLauncher,
        },
        projectRoot: "/project",
        version: "1.0.0",
        pollIntervalMs: 5,
      },
      {
        stop: async () => ({
          wasRunning: true,
          projectRoot: "/project",
          pausedRunCount: 1,
          pausedRunIds: ["run-1"],
          pausedRunIdsTruncated: false,
        }),
      },
    );
    const replacement = `${activeLauncher}.new`;
    await symlink(secondLauncher, replacement);
    await rename(replacement, activeLauncher);

    await expect(handoff).resolves.toEqual({
      wasRunning: true,
      projectRoot: "/project",
      pausedRunCount: 1,
      pausedRunIds: ["run-1"],
      pausedRunIdsTruncated: false,
    });
  });

  it("retries a transient upgrade quiesce race without reopening stale work", async () => {
    const prefix = await realpath(await mkdtemp(path.join(tmpdir(), "koni-upgrade-retry-")));
    temporaryRoots.push(prefix);
    const firstLauncher = versionedLauncher(prefix, "bundle-a");
    const secondLauncher = versionedLauncher(prefix, "bundle-b");
    await Promise.all(
      [firstLauncher, secondLauncher].map(async (launcher) => {
        await mkdir(path.dirname(launcher), { recursive: true });
        await writeFile(launcher, "#!/usr/bin/env node\n", "utf8");
      }),
    );
    const activeLauncher = path.join(prefix, "bin", "koni");
    await mkdir(path.dirname(activeLauncher), { recursive: true });
    await symlink(secondLauncher, activeLauncher);
    let attempts = 0;

    const result = await stopAuthorityWhenInstallationSuperseded(
      {
        binding: {
          activeLauncherPath: activeLauncher,
          expectedLauncherPath: firstLauncher,
        },
        projectRoot: "/project",
        version: "1.0.0",
        pollIntervalMs: 1,
        retryIntervalMs: 1,
      },
      {
        stop: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(new Error("authority is settling a merge"), { retryable: true });
          }
          return {
            wasRunning: true,
            projectRoot: "/project",
            pausedRunCount: 1,
            pausedRunIds: ["run-1"],
            pausedRunIdsTruncated: false,
          };
        },
      },
    );

    expect(result.pausedRunIds).toEqual(["run-1"]);
    expect(attempts).toBe(2);
  });

  it("waits for an already-bound authority to finish recovery without launching a duplicate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "koni-operator-starting-"));
    temporaryRoots.push(root);
    const projectRoot = path.join(root, "project");
    await mkdir(projectRoot);
    await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
    await installAndCacheProfile({
      projectRoot,
      profilePackageRoot: path.join(repositoryRoot, "packages", "coding-profile"),
    });

    const server = new AuthorityServer({
      projectRoot,
      version: "1.0.0",
      deferReadyUntilRecovery: true,
    });
    server.register("project.status", {
      mutating: false,
      handle: () => ({ result: { projectRoot, version: "1.0.0", revision: 0, runCount: 0 } }),
    });
    await server.start();
    const launch = vi.fn(async () => ({}));
    const ready = new Promise<void>((resolve) =>
      setTimeout(() => {
        server.completeStartupRecovery();
        resolve();
      }, 150),
    );
    const client = await withAuthenticatedPiRuntime(() =>
      ensureProjectAuthority({
        projectRoot,
        version: "1.0.0",
        client: "cli",
        launch,
        timeoutMs: 3_000,
      }),
    );
    await ready;
    expect(launch).not.toHaveBeenCalled();
    client.close();
    await server.stop();
  }, 30_000);

  it("does not mistake a losing child exit for failure while a cold winner binds after 500ms", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "koni-operator-cold-race-"));
    temporaryRoots.push(root);
    const projectRoot = path.join(root, "project");
    await mkdir(projectRoot);
    await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
    await installAndCacheProfile({
      projectRoot,
      profilePackageRoot: path.join(repositoryRoot, "packages", "coding-profile"),
    });

    const winner = new AuthorityServer({ projectRoot, version: "1.0.0" });
    winner.register("project.status", {
      mutating: false,
      handle: () => ({ result: { projectRoot, version: "1.0.0", revision: 0, runCount: 0 } }),
    });
    let winnerStartup: Promise<void> | undefined;
    const launch = vi.fn(async () => {
      winnerStartup = new Promise<void>((resolve, reject) =>
        setTimeout(() => {
          winner.start().then(() => resolve(), reject);
        }, 750),
      );
      return { exited: Promise.resolve({ code: 1, signal: null }) };
    });
    const client = await withAuthenticatedPiRuntime(() =>
      ensureProjectAuthority({
        projectRoot,
        version: "1.0.0",
        client: "cli",
        launch,
        timeoutMs: 4_000,
      }),
    );
    await winnerStartup;
    expect(launch).toHaveBeenCalledOnce();
    client.close();
    await winner.stop();
  }, 30_000);
});

async function withAuthenticatedPiRuntime<T>(operation: () => Promise<T>): Promise<T> {
  const packageRoot = await realpath(
    path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent"),
  );
  const previousArgv = process.argv[1];
  process.argv[1] = path.join(packageRoot, "package.json");
  try {
    return await operation();
  } finally {
    if (previousArgv === undefined) process.argv.splice(1, 1);
    else process.argv[1] = previousArgv;
  }
}

describe("Pi profile source discovery", () => {
  it("rejects different manifest URLs for one package instead of accepting load-order wins", () => {
    const handlers = new Map<string, Set<(value: unknown) => void>>();
    const events = {
      on(topic: string, handler: (value: unknown) => void) {
        const listeners = handlers.get(topic) ?? new Set();
        listeners.add(handler);
        handlers.set(topic, listeners);
        return () => listeners.delete(handler);
      },
      emit(topic: string, value: unknown) {
        for (const listener of handlers.get(topic) ?? []) listener(value);
      },
    };
    const catalog = new PiProfileSourceCatalog(events);
    const announce = (manifest_url: string) =>
      events.emit("koni.profile.available.v1", {
        protocol: "koni.profile-source.v1",
        package: "@koni/coding-profile",
        manifest_url,
      });
    announce("file:///one/koni/profile-manifest.json");
    announce("file:///one/koni/profile-manifest.json");
    expect(catalog.discover()).toHaveLength(1);
    announce("file:///two/koni/profile-manifest.json");
    expect(() => catalog.discover()).toThrowError(/different manifests/);
    catalog.dispose();
  });
});

function fakePi(): {
  pi: ExtensionAPI;
  commands: Map<string, { handler(args: string, context: ExtensionCommandContext): Promise<void> }>;
  notifications: Array<{ message: string; type: string | undefined }>;
} {
  const eventHandlers = new Map<string, (payload: unknown) => void>();
  return fakePiWithEvents({
    on(channel: string, handler: (payload: unknown) => void) {
      eventHandlers.set(channel, handler);
      return () => eventHandlers.delete(channel);
    },
    emit(channel: string, payload: unknown) {
      eventHandlers.get(channel)?.(payload);
    },
  });
}

function fakePiWithEvents(events: {
  on(channel: string, handler: (payload: unknown) => void): () => void;
  emit(channel: string, payload: unknown): void;
}): {
  pi: ExtensionAPI;
  commands: Map<string, { handler(args: string, context: ExtensionCommandContext): Promise<void> }>;
  notifications: Array<{ message: string; type: string | undefined }>;
} {
  const commands = new Map<
    string,
    { handler(args: string, context: ExtensionCommandContext): Promise<void> }
  >();
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const pi = {
    events,
    registerCommand(name: string, command: unknown) {
      commands.set(
        name,
        command as { handler(args: string, context: ExtensionCommandContext): Promise<void> },
      );
    },
    registerTool() {},
    on() {},
  } as unknown as ExtensionAPI;
  return { pi, commands, notifications };
}

function fakeCommandContext(
  notifications: Array<{ message: string; type: string | undefined }> = [],
): ExtensionCommandContext {
  return {
    cwd: "/project",
    mode: "tui",
    hasUI: true,
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  } as unknown as ExtensionCommandContext;
}

function fakeCliDependencies(): KoniCliDependencies {
  return {
    ensure: vi.fn(),
    inspect: vi.fn(async () => ({
      running: false,
      projectRoot: "/project",
      commonDirectory: "/project/.git",
      stateRoot: "/project/.git/koni",
      endpoint: "/tmp/koni.sock",
      profile: {
        packageName: "@koni/coding-profile",
        profileId: "software",
        profileVersion: "0.6.0",
        bundleSha256: `sha256:${"a".repeat(64)}`,
      },
    })),
    serve: vi.fn(),
    stop: vi.fn(),
    validate: vi.fn(),
    resolveAgent: vi.fn(),
    install: vi.fn(),
    previewInstall: vi.fn(),
    resolveProfile: vi.fn(),
    readInstalled: vi.fn(),
    run: vi.fn(),
    resumeRun: vi.fn(),
    approveRun: vi.fn(),
    decideProposal: vi.fn(),
    standalone: vi.fn(),
  } as unknown as KoniCliDependencies;
}

function versionedLauncher(prefix: string, bundle: string): string {
  return path.join(
    prefix,
    "share",
    "koni",
    "versions",
    bundle,
    "package-root",
    "node_modules",
    "@koni",
    "core",
    "bin",
    "koni.js",
  );
}

function modelAdmissionCatalog() {
  const intake = [
    {
      id: "goal",
      label: "Goal",
      description: "Describe the outcome Koni should deliver.",
      kind: "text",
      required: true,
      options: [],
    },
  ];
  return {
    protocol: "koni.control-catalog.v1",
    defaultRunTypeId: "small",
    runTypes: [
      {
        id: "small",
        title: "Small",
        description: "Small run",
        questionPolicy: "none",
        maxParallel: 1,
        startMode: "planning",
        objectiveFieldId: "goal",
        intake,
        questionDefaultScope: "run",
        autoStart: true,
        runCardSections: ["goal", "pipeline", "graph", "tickets", "checks", "report"],
        stages: [],
        roles: [
          {
            id: "planner",
            title: "Planner",
            provider: "openai-codex",
            model: "gpt-small",
            thinkingLevel: "high",
          },
        ],
      },
    ],
  };
}
