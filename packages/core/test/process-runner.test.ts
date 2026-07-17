import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContainedProcessError,
  runContainedProcess,
  snapshotContainedPaths,
} from "../src/authority/process-runner.js";
import { canonicalHash } from "../src/shared/canonical.js";
import type { ResolvedAgentCheckCommand } from "../src/authority/run-engine.js";
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

  it.runIf(process.platform === "darwin")(
    "runs exact argv in Seatbelt while hiding project secrets",
    async () => {
      const root = await temporaryRoot();
      const stateRoot = await temporaryRoot();
      const launcherRoot = await temporaryRoot();
      const launcher = path.join(launcherRoot, "sandbox-exec");
      await writeFile(launcher, "#!/bin/sh\nexec /usr/bin/sandbox-exec \"$@\"\n", "utf8");
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
        readPaths: ["visible.txt"],
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
        readPaths: ["."],
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
        check: command([
          process.execPath,
          "-e",
          "require('fs').writeFileSync('out.txt','after\\n')",
        ], "workspace_write"),
        readPaths: ["out.txt"],
        writePaths: ["out.txt"],
      });
      expect(result.exitCode).toBe(0);
      expect(await readFile(path.join(root, "out.txt"), "utf8")).toBe("after\n");
    },
  );

  it("rejects an invalid command contract before spawning", async () => {
    const root = await temporaryRoot();
    const stateRoot = await temporaryRoot();
    const invalid = { ...command([process.execPath, "-e", "0"]), timeoutMs: 0 };
    await expect(runContainedProcess({
      projectRoot: root,
      stateRoot,
      check: invalid,
      readPaths: ["."],
      writePaths: [],
    })).rejects.toBeInstanceOf(ContainedProcessError);
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
