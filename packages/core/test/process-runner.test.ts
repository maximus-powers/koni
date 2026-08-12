import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContainedProcessError,
  runContainedProcess,
  snapshotContainedPaths,
} from "../src/authority/process-runner.js";
import { canonicalHash } from "../src/shared/canonical.js";
import {
  configuredCheckFailureDiagnostics,
  shouldProjectConfiguredCheckDiagnostics,
  type AgentCheckExecution,
  type ResolvedAgentCheckCommand,
} from "../src/authority/run-engine.js";
import { captureRuntimeExecutable } from "../src/runtime/executable.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("configured process containment", () => {
  it("hashes bounded regular workspace manifests and rejects symlinks", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, "a.txt"), "alpha\n");
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested/b.txt"), "beta\n");
    const first = await snapshotContainedPaths(root, ["a.txt", "nested"]);
    const second = await snapshotContainedPaths(root, ["nested", "a.txt"]);
    expect(first.manifestSha256).toBe(second.manifestSha256);
    expect(first.entries.map((entry) => entry.path)).toEqual(["a.txt", "nested", "nested/b.txt"]);

    await symlink(path.join(root, "a.txt"), path.join(root, "link.txt"));
    await expect(snapshotContainedPaths(root, ["link.txt"])).rejects.toMatchObject({
      code: "manifest_symlink",
    });
  });

  it("keeps an explicitly empty configured path set empty", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, "unrelated-large-artifact.bin"), "not part of this check\n");

    const manifest = await snapshotContainedPaths(root, []);

    expect(manifest.roots).toEqual([]);
    expect(manifest.entries).toEqual([]);
    expect(manifest.manifestSha256).toBe(
      canonicalHash({
        protocol: "koni.contained-path-manifest.v1",
        roots: [],
        entries: [],
      }),
    );
  });

  it.runIf(process.platform === "darwin")(
    "reads repository source in Seatbelt while hiding project secrets",
    async () => {
      const root = await temporaryRoot();
      const stateRoot = await temporaryRoot();
      const launcherRoot = await temporaryRoot();
      const launcher = path.join(launcherRoot, "sandbox-exec");
      await writeFile(launcher, '#!/bin/sh\nexec /usr/bin/sandbox-exec "$@"\n', "utf8");
      await chmod(launcher, 0o700);
      const sandboxExecutable = await captureRuntimeExecutable("sandbox", launcher);
      await writeFile(path.join(root, "visible.txt"), "visible\n");
      await writeFile(path.join(root, ".env"), "SECRET=not-for-checks\n");
      const visible = await runContainedProcess({
        projectRoot: root,
        stateRoot,
        check: command([
          process.execPath,
          "-e",
          "process.stdout.write(require('fs').readFileSync('visible.txt'))",
        ]),
        readPaths: [],
        writePaths: [],
        sandboxExecutable,
      });
      expect(visible.exitCode).toBe(0);
      expect(visible.stdout.toString("utf8")).toBe("visible\n");
      expect(visible.sandbox.executableSha256).toBe(sandboxExecutable.sha256);

      const secret = await runContainedProcess({
        projectRoot: root,
        stateRoot,
        check: command([
          process.execPath,
          "-e",
          "process.stdout.write(require('fs').readFileSync('.env'))",
        ]),
        readPaths: [],
        writePaths: [],
        sandboxExecutable,
      });
      expect(secret.exitCode).not.toBe(0);
      expect(secret.stdout.toString("utf8")).not.toContain("not-for-checks");
    },
  );

  it.runIf(process.platform === "darwin")(
    "allows only a compiler-granted workspace write",
    async () => {
      const root = await temporaryRoot();
      const stateRoot = await temporaryRoot();
      await writeFile(path.join(root, "out.txt"), "before\n");
      const result = await runContainedProcess({
        projectRoot: root,
        stateRoot,
        check: command(
          [process.execPath, "-e", "require('fs').writeFileSync('out.txt','after\\n')"],
          "workspace_write",
        ),
        readPaths: ["out.txt"],
        writePaths: ["out.txt"],
      });
      expect(result.exitCode).toBe(0);
      expect(await readFile(path.join(root, "out.txt"), "utf8")).toBe("after\n");
    },
  );

  it.runIf(process.platform === "darwin")(
    "reuses primary-checkout Node dependencies read-only in a managed worktree",
    async () => {
      const primary = await temporaryRoot();
      const stateRoot = path.join(primary, ".git", "koni");
      const managed = path.join(primary, ".git", ".koni-worktrees", "ticket");
      const relativeCwd = path.join("apps", "books");
      const dependency = path.join(primary, relativeCwd, "node_modules", "fixture-dependency");
      const primaryWorkspacePackage = path.join(primary, "packages", "fixture-config");
      const managedWorkspacePackage = path.join(managed, "packages", "fixture-config");
      await mkdir(stateRoot, { recursive: true });
      await mkdir(path.join(managed, relativeCwd), { recursive: true });
      await mkdir(path.join(managed, relativeCwd, "node_modules", ".vite"), { recursive: true });
      await mkdir(dependency, { recursive: true });
      await mkdir(primaryWorkspacePackage, { recursive: true });
      await mkdir(managedWorkspacePackage, { recursive: true });
      await mkdir(path.join(primary, relativeCwd, "node_modules", "@fixture"));
      await writeFile(
        path.join(dependency, "package.json"),
        JSON.stringify({
          name: "fixture-dependency",
          main: "index.cjs",
        }),
      );
      await writeFile(
        path.join(dependency, "index.cjs"),
        "module.exports = 'shared dependency\\n';\n",
      );
      await writeFile(
        path.join(primaryWorkspacePackage, "package.json"),
        JSON.stringify({
          name: "@fixture/config",
          main: "index.cjs",
        }),
      );
      await writeFile(
        path.join(primaryWorkspacePackage, "index.cjs"),
        "module.exports = 'primary workspace\\n';\n",
      );
      await writeFile(
        path.join(managedWorkspacePackage, "package.json"),
        JSON.stringify({
          name: "@fixture/config",
          main: "index.cjs",
        }),
      );
      await writeFile(
        path.join(managedWorkspacePackage, "index.cjs"),
        "module.exports = 'managed workspace\\n';\n",
      );
      await symlink(
        primaryWorkspacePackage,
        path.join(primary, relativeCwd, "node_modules", "@fixture", "config"),
        "dir",
      );

      const result = await runContainedProcess({
        projectRoot: managed,
        stateRoot,
        check: {
          ...command([
            process.execPath,
            "-e",
            "process.stdout.write(require('fixture-dependency') + require('@fixture/config'))",
          ]),
          cwd: relativeCwd.split(path.sep).join("/"),
        },
        readPaths: [],
        writePaths: [],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString("utf8")).toBe("shared dependency\nmanaged workspace\n");
      expect(
        await realpath(path.join(managed, relativeCwd, "node_modules", "fixture-dependency")),
      ).toBe(await realpath(dependency));
      expect(
        (await lstat(path.join(managed, relativeCwd, "node_modules", ".vite"))).isDirectory(),
      ).toBe(true);
      expect(
        await realpath(path.join(managed, relativeCwd, "node_modules", "@fixture", "config")),
      ).toBe(await realpath(managedWorkspacePackage));
    },
  );

  it.runIf(process.platform === "darwin")(
    "reconciles a target-branch dependency version from an existing workspace cache",
    async () => {
      const primary = await temporaryRoot();
      const stateRoot = path.join(primary, ".git", "koni");
      const managed = path.join(primary, ".git", ".koni-worktrees", "ticket");
      const relativeCwd = path.join("apps", "books");
      const currentDependency = path.join(
        primary,
        relativeCwd,
        "node_modules",
        "fixture-dependency",
      );
      const historicalDependency = path.join(
        primary,
        "packages",
        "legacy-consumer",
        "node_modules",
        "fixture-dependency",
      );
      const managedWorkspaceDependency = path.join(managed, "packages", "fixture-config");
      await mkdir(stateRoot, { recursive: true });
      await mkdir(path.join(managed, relativeCwd), { recursive: true });
      await mkdir(currentDependency, { recursive: true });
      await mkdir(historicalDependency, { recursive: true });
      await mkdir(managedWorkspaceDependency, { recursive: true });
      await writeFile(
        path.join(currentDependency, "package.json"),
        JSON.stringify({
          name: "fixture-dependency",
          version: "2.0.0",
          main: "index.cjs",
        }),
      );
      await writeFile(
        path.join(currentDependency, "index.cjs"),
        "module.exports = 'current\\n';\n",
      );
      await writeFile(
        path.join(historicalDependency, "package.json"),
        JSON.stringify({
          name: "fixture-dependency",
          version: "1.0.0",
          main: "index.cjs",
        }),
      );
      await writeFile(
        path.join(historicalDependency, "index.cjs"),
        "module.exports = 'target branch\\n';\n",
      );
      await writeFile(
        path.join(managedWorkspaceDependency, "package.json"),
        JSON.stringify({
          name: "@fixture/config",
          version: "1.0.0",
          main: "index.cjs",
        }),
      );
      await writeFile(
        path.join(managedWorkspaceDependency, "index.cjs"),
        "module.exports = 'managed workspace\\n';\n",
      );
      await writeFile(
        path.join(managed, "package.json"),
        JSON.stringify({
          name: "target-root",
          devDependencies: { "@fixture/config": "workspace:*" },
        }),
      );
      await writeFile(
        path.join(managed, relativeCwd, "package.json"),
        JSON.stringify({
          name: "books",
          dependencies: { "fixture-dependency": "1.0.0" },
        }),
      );

      const result = await runContainedProcess({
        projectRoot: managed,
        stateRoot,
        check: {
          ...command([
            process.execPath,
            "-e",
            "process.stdout.write(require('fixture-dependency') + require('@fixture/config'))",
          ]),
          cwd: relativeCwd.split(path.sep).join("/"),
        },
        readPaths: [],
        writePaths: [],
      });

      expect(result.exitCode, result.stderr.toString("utf8")).toBe(0);
      expect(result.stdout.toString("utf8")).toBe("target branch\nmanaged workspace\n");
      expect(
        await realpath(path.join(managed, relativeCwd, "node_modules", "fixture-dependency")),
      ).toBe(await realpath(historicalDependency));
      expect(await realpath(path.join(managed, "node_modules", "@fixture", "config"))).toBe(
        await realpath(managedWorkspaceDependency),
      );

      const repeated = await runContainedProcess({
        projectRoot: managed,
        stateRoot,
        check: {
          ...command([
            process.execPath,
            "-e",
            "process.stdout.write(require('fixture-dependency') + require('@fixture/config'))",
          ]),
          cwd: relativeCwd.split(path.sep).join("/"),
        },
        readPaths: [],
        writePaths: [],
      });
      expect(repeated.exitCode, repeated.stderr.toString("utf8")).toBe(0);
      expect(repeated.stdout.toString("utf8")).toBe("target branch\nmanaged workspace\n");
    },
  );

  it.runIf(process.platform === "darwin")(
    "admits the read-only runtime closure of an env-node command shim",
    async () => {
      const root = await temporaryRoot();
      const stateRoot = await temporaryRoot();
      const runtime = await temporaryRoot();
      const aliases = await temporaryRoot();
      await mkdir(path.join(runtime, "bin"));
      await mkdir(path.join(runtime, "lib"));
      await writeFile(
        path.join(runtime, "lib", "message.cjs"),
        "module.exports = 'shim runtime\\n';\n",
      );
      const tool = path.join(runtime, "bin", "fixture-tool");
      await writeFile(
        tool,
        "#!/usr/bin/env node\nprocess.stdout.write(require('../lib/message.cjs'));\n",
      );
      await chmod(tool, 0o700);
      const nodeAlias = path.join(aliases, "lts");
      await symlink(path.dirname(path.dirname(process.execPath)), nodeAlias, "dir");
      const pathValue = [
        path.join(runtime, "bin"),
        path.join(nodeAlias, "bin"),
        "/usr/bin",
        "/bin",
      ].join(path.delimiter);

      const result = await runContainedProcess({
        projectRoot: root,
        stateRoot,
        check: {
          ...command(["fixture-tool"]),
          environment: { inherit: [], set: { PATH: pathValue } },
        },
        readPaths: [],
        writePaths: [],
      });

      expect(result.exitCode, result.stderr.toString("utf8")).toBe(0);
      expect(result.stdout.toString("utf8")).toBe("shim runtime\n");
    },
  );

  it.runIf(process.platform === "darwin")(
    "admits a configured Python user site without exposing the rest of HOME",
    async () => {
      const root = await temporaryRoot();
      const stateRoot = await temporaryRoot();
      const runtime = await temporaryRoot();
      const home = await temporaryRoot();
      const userSite = path.join(
        home,
        "Library",
        "Python",
        "3.14",
        "lib",
        "python",
        "site-packages",
      );
      await mkdir(path.join(runtime, "bin"), { recursive: true });
      await mkdir(userSite, { recursive: true });
      await writeFile(path.join(userSite, "fixture.txt"), "user dependency\n");
      await writeFile(path.join(home, "secret.txt"), "not for checks\n");
      const python = path.join(runtime, "bin", "python3.14");
      await writeFile(
        python,
        [
          "#!/bin/sh",
          'cat "$HOME/Library/Python/3.14/lib/python/site-packages/fixture.txt"',
          'cat "$HOME/secret.txt" 2>/dev/null || true',
          "",
        ].join("\n"),
      );
      await chmod(python, 0o700);

      const result = await runContainedProcess({
        projectRoot: root,
        stateRoot,
        check: {
          ...command([python]),
          environment: { inherit: [], set: { HOME: home } },
        },
        readPaths: [],
        writePaths: [],
      });

      expect(result.exitCode, result.stderr.toString("utf8")).toBe(0);
      expect(result.stdout.toString("utf8")).toBe("user dependency\n");
    },
  );

  it("rejects an invalid command contract before spawning", async () => {
    const root = await temporaryRoot();
    const stateRoot = await temporaryRoot();
    const invalid = { ...command([process.execPath, "-e", "0"]), timeoutMs: 0 };
    await expect(
      runContainedProcess({
        projectRoot: root,
        stateRoot,
        check: invalid,
        readPaths: ["."],
        writePaths: [],
      }),
    ).rejects.toBeInstanceOf(ContainedProcessError);
  });
});

describe("configured check diagnostics", () => {
  it("returns only the bounded failing command output", () => {
    const successful = diagnosticExecution("first", 0, "ok", "");
    const failed = diagnosticExecution(
      "second",
      127,
      "ignored stdout",
      `\u001b[31menv: node: No such file or directory\u001b[0m\n${"x".repeat(3_000)}`,
    );
    const diagnostics = configuredCheckFailureDiagnostics(
      {
        commands: [command(["first"]), command(["second"])],
      },
      [successful, failed],
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      commandIndex: 1,
      checkId: "second",
      exitCode: 127,
      expectedExitCodes: [0],
    });
    expect(String(diagnostics[0]?.stderrTail)).not.toContain("\u001b");
    expect(Buffer.byteLength(String(diagnostics[0]?.stderrTail), "utf8")).toBeLessThanOrEqual(
      2_048,
    );
  });

  it("projects bounded streams for an accepted expected-red contract", () => {
    const expectedRed = command(["expected-red"]);
    expectedRed.expectedExitCodes = [1, 101];

    expect(shouldProjectConfiguredCheckDiagnostics({ commands: [expectedRed] }, true)).toBe(true);
    expect(shouldProjectConfiguredCheckDiagnostics({ commands: [command(["green"])] }, true)).toBe(
      false,
    );
    expect(
      shouldProjectConfiguredCheckDiagnostics({ commands: [command(["failed"])] }, false),
    ).toBe(true);
  });
});

function command(
  argv: string[],
  effect: "read_only" | "workspace_write" = "read_only",
): ResolvedAgentCheckCommand {
  return {
    checkId: "test-check",
    definitionHash: canonicalHash({ argv, effect }),
    argv,
    cwd: ".",
    timeoutMs: 10_000,
    effect,
    networkAccess: false,
    environment: { inherit: ["PATH"], set: {} },
    expectedExitCodes: [0],
    allowNonpassingReceipt: false,
    receiptType: "test.receipt",
    requiredResultFields: [],
    resultSource: { kind: "stdout" },
    inputPaths: ["."],
    outputPaths: effect === "workspace_write" ? ["out.txt"] : [],
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "koni-process-test-"));
  roots.push(root);
  return root;
}

function diagnosticExecution(
  checkId: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): AgentCheckExecution {
  return {
    checkId,
    definitionHash: canonicalHash({ checkId }),
    startedAt: "2026-07-19T00:00:00.000Z",
    completedAt: "2026-07-19T00:00:01.000Z",
    resolvedExecutable: "/usr/bin/true",
    argv: [checkId],
    environmentSha256: canonicalHash({}),
    exitCode,
    signal: null,
    stdout,
    stderr,
    stdoutSha256: canonicalHash(stdout),
    stdoutSizeBytes: Buffer.byteLength(stdout),
    stderrSha256: canonicalHash(stderr),
    stderrSizeBytes: Buffer.byteLength(stderr),
    preManifestSha256: canonicalHash({ pre: checkId }),
    postManifestSha256: canonicalHash({ post: checkId }),
    sandboxKind: "test",
    sandboxProfileSha256: canonicalHash({ sandbox: true }),
    resultSource: {
      kind: "stdout",
      bytesSha256: canonicalHash(stdout),
      sizeBytes: Buffer.byteLength(stdout),
      value: null,
    },
    outputFiles: [],
  };
}
