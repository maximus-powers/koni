import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
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
} from "../src/operator/authority-bootstrap.js";
import {
  createRunFromPi,
  projectPiModels,
} from "../src/operator/control-center-host.js";
import {
  installAndCacheProfile,
  loadCachedInstalledProfile,
  PiProfileSourceCatalog,
} from "../src/operator/profile-source.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Pi operator extension", () => {
  it("projects the contained runtime catalog and disables ambient-only Pi providers", async () => {
    const native = { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol", reasoning: true };
    const extensionOnly = { provider: "community", id: "custom", name: "Community Custom", reasoning: true };
    const getAll = vi.fn(() => [native, extensionOnly]);
    const getAvailable = vi.fn(() => [native, extensionOnly]);
    const getRegisteredProviderIds = vi.fn(() => ["community"]);
    const runtime = {
      getModels: vi.fn(() => [native]),
      getAvailableSnapshot: vi.fn(() => [native]),
    };
    const models = await projectPiModels({
      modelRegistry: { getAll, getAvailable, getRegisteredProviderIds } as never,
    }, { runtime });
    expect(models).toEqual([
      { ...native, thinkingLevels: ["off", "minimal", "low", "medium", "high"], available: true },
      {
        ...extensionOnly,
        thinkingLevels: ["off", "minimal", "low", "medium", "high"] as const,
        available: false,
        unavailableReason: "This provider comes from an ambient Pi extension; contained Koni attempts do not load ambient extensions.",
      },
    ]);
    expect(getAll).toHaveBeenCalledOnce();
    expect(getAvailable).not.toHaveBeenCalled();
    expect(getRegisteredProviderIds).toHaveBeenCalledOnce();
  });

  it("is inert until /koni is invoked and mounts the shared control-center host on demand", async () => {
    const extensionHandlers = new Map<string, (...arguments_: any[]) => unknown>();
    const eventHandlers = new Map<string, (payload: unknown) => void>();
    const commands = new Map<string, { handler(args: string, context: ExtensionCommandContext): Promise<void> }>();
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
        commands.set(name, command as { handler(args: string, context: ExtensionCommandContext): Promise<void> });
      },
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
    createKoniCoreExtension({ assertPiHost: vi.fn(async () => undefined), openControlCenter: firstOpen })(first.pi);
    createKoniCoreExtension({ assertPiHost: vi.fn(async () => undefined), openControlCenter: secondOpen })(second.pi);

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

  it("shuts Pi down at session start for a legacy duplicate and gives scope-correct removal", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const notifications: Array<{ message: string; type: string | undefined }> = [];
    const shutdown = vi.fn();
    const pi = {
      events: {
        on() { return () => undefined; },
        emit() {},
      },
      registerCommand() {},
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
      on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, handler); },
    } as unknown as ExtensionAPI;
    createKoniCoreExtension()(pi);
    const context = {
      ...fakeCommandContext(notifications),
      shutdown,
    } as unknown as ExtensionCommandContext;

    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, context);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("error");
    expect(notifications[0]?.message).toContain("pi remove 'npm:@koni/core@0.9.0'`");
    expect(notifications[0]?.message).not.toContain("npm:@koni/core@0.9.0' --local");
    expect(notifications[0]?.message).toContain("pi remove '../koni' --local");
  });

  it("shuts down before interactive work when the active Pi host is unsupported", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const notifications: Array<{ message: string; type: string | undefined }> = [];
    const shutdown = vi.fn();
    const open = vi.fn(async () => undefined);
    const pi = {
      events: { on() { return () => undefined; }, emit() {} },
      registerCommand() {},
      getCommands: () => [{
        name: "koni",
        source: "extension",
        sourceInfo: { path: "/koni/extension.js", source: "npm:@koni/core", scope: "user", origin: "package" },
      }],
      on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, handler); },
    } as unknown as ExtensionAPI;
    createKoniCoreExtension({
      assertPiHost: vi.fn(async () => { throw new Error("Pi 0.80.11 is unsupported"); }),
      openControlCenter: open,
    })(pi);
    const context = { ...fakeCommandContext(notifications), shutdown } as unknown as ExtensionCommandContext;

    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, context);

    expect(shutdown).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(notifications).toEqual([expect.objectContaining({
      type: "error",
      message: expect.stringContaining("Pi 0.80.11 is unsupported"),
    })]);
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

    await expect(createRunFromPi({ context, version: "1.0.0" }, {
      ensure: vi.fn(async () => client as never),
      loadModels: vi.fn(async () => [{
        provider: "openai-codex",
        id: "gpt-small",
        name: "GPT Small",
        reasoning: true,
        thinkingLevels: ["off", "minimal", "low", "medium", "high"] as const,
        available: false,
        unavailableReason: "No Pi credential is configured.",
      }]),
    })).rejects.toThrow(/No Pi credential is configured/);
    expect(calls).toEqual(["control.catalog"]);
    expect(client.close).toHaveBeenCalledOnce();
  });
});

describe("shell operator surface", () => {
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
    expect(await runKoniCli(["status", "--json"], io, dependencies)).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject({ running: false, projectRoot: "/project" });
    expect(dependencies.ensure).not.toHaveBeenCalled();
    expect(dependencies.standalone).not.toHaveBeenCalled();
  });

  it("exposes legacy adoption as preview, explicit apply, and explicit successor resume", async () => {
    const output: string[] = [];
    const io: KoniCliIO = {
      stdout: (text) => output.push(text),
      stderr: () => undefined,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    };
    const dependencies = fakeCliDependencies();
    vi.mocked(dependencies.previewLegacyRuns).mockResolvedValue({
      protocol: "koni.legacy-run-adoption-catalog.v1",
      migrationId: "migration-one",
      projectRoot: "/project",
      sourceRetained: true,
      runs: [{ runId: "legacy-one", disposition: "ready" }],
    });
    vi.mocked(dependencies.adoptLegacyRun).mockResolvedValue({
      migrationId: "migration-one",
      sourceRunId: "legacy-one",
      successorRunId: "run-successor",
      status: "adopted_paused",
      phase: "paused",
      sourceRetained: true,
    });
    vi.mocked(dependencies.resumeRun).mockResolvedValue({
      runId: "run-successor",
      status: "draft",
    });

    expect(await runKoniCli([
      "adopt", "--migration", "migration-one", "--root", "/project", "--json",
    ], io, dependencies)).toBe(0);
    expect(dependencies.previewLegacyRuns).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: "/project",
      migrationId: "migration-one",
    }));
    expect(dependencies.adoptLegacyRun).not.toHaveBeenCalled();

    expect(await runKoniCli([
      "adopt", "--migration", "migration-one", "--run", "legacy-one", "--apply",
      "--root", "/project", "--json",
    ], io, dependencies)).toBe(0);
    expect(dependencies.adoptLegacyRun).toHaveBeenCalledWith(expect.objectContaining({
      migrationId: "migration-one",
      runId: "legacy-one",
    }));

    expect(await runKoniCli([
      "resume", "--run", "run-successor", "--root", "/project", "--json",
    ], io, dependencies)).toBe(0);
    expect(dependencies.resumeRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-successor" }));
    expect(output.map((entry) => JSON.parse(entry))).toEqual([
      expect.objectContaining({ migrationId: "migration-one" }),
      expect.objectContaining({ successorRunId: "run-successor" }),
      expect.objectContaining({ runId: "run-successor", status: "draft" }),
    ]);
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

    await expect(createProjectRun({
      projectRoot: "/project",
      version: "1.0.0",
      objective: "Build notes",
      runTypeId: "small",
      targetRef: "main",
    }, {
      ensure: vi.fn(async () => client as never),
      loadModels: vi.fn(async () => [{
        provider: "openai-codex",
        id: "gpt-small",
        name: "GPT Small",
        reasoning: true,
        thinkingLevels: ["off", "minimal", "low", "medium", "high"] as const,
        available: false,
        unavailableReason: "No Pi credential is configured.",
      }]),
    })).rejects.toThrow(/No Pi credential is configured/);
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

    const installed = await installAndCacheProfile({ projectRoot, profilePackageRoot: packageRoot });
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
    await execFileAsync("cp", ["-R", path.join(repositoryRoot, "packages", "coding-profile"), sourceRoot]);
    let installedFrom: string | undefined;
    const installed = await installAndCacheProfile({ projectRoot, profilePackageRoot: sourceRoot }, {
      install: async (target, packageRoot) => {
        installedFrom = packageRoot;
        await rm(sourceRoot, { recursive: true, force: true });
        const { installProfile } = await import("../src/profile/install.js");
        return installProfile(target, packageRoot);
      },
    });
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
    const authenticatePi = vi.fn(async () => ({} as never));
    const first = await ensureProjectAuthority({
      projectRoot: nested,
      version: "1.0.0",
      client: "cli",
      launch,
      resolvePiRuntime: authenticatePi,
      timeoutMs: 3_000,
    });
    const shouldNotLaunch = vi.fn(async () => ({}));
    const second = await ensureProjectAuthority({
      projectRoot,
      version: "1.0.0",
      client: "pi-extension",
      launch: shouldNotLaunch,
      resolvePiRuntime: authenticatePi,
      timeoutMs: 3_000,
    });
    expect(launch).toHaveBeenCalledOnce();
    expect(shouldNotLaunch).not.toHaveBeenCalled();
    expect(authenticatePi).toHaveBeenCalledTimes(2);
    first.close();
    second.close();
    await server.stop();
  }, 30_000);
});

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
    const catalog = new PiProfileSourceCatalog(events as never);
    const announce = (manifest_url: string) => events.emit("koni.profile.available.v1", {
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
    emit(channel: string, payload: unknown) { eventHandlers.get(channel)?.(payload); },
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
  const commands = new Map<string, { handler(args: string, context: ExtensionCommandContext): Promise<void> }>();
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const pi = {
    events,
    registerCommand(name: string, command: unknown) {
      commands.set(name, command as { handler(args: string, context: ExtensionCommandContext): Promise<void> });
    },
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
      notify(message: string, type?: string) { notifications.push({ message, type }); },
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
    install: vi.fn(),
    resolveProfile: vi.fn(),
    readInstalled: vi.fn(),
    run: vi.fn(),
    previewLegacyRuns: vi.fn(),
    adoptLegacyRun: vi.fn(),
    resumeRun: vi.fn(),
    standalone: vi.fn(),
  } as unknown as KoniCliDependencies;
}

function modelAdmissionCatalog() {
  return {
    protocol: "koni.control-catalog.v1",
    runTypes: [{
      id: "small",
      title: "Small",
      description: "Small run",
      questionPolicy: "none",
      maxParallel: 1,
      startMode: "planning",
      stages: [],
      roles: [{
        id: "planner",
        title: "Planner",
        provider: "openai-codex",
        model: "gpt-small",
        thinkingLevel: "high",
      }],
    }],
  };
}
