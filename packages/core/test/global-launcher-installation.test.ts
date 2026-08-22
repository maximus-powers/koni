import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateGlobalLauncher,
  GLOBAL_LAUNCHER_TEST_HOOK,
  isPiUserPackageInstallation,
  removeGlobalLauncher,
  type GlobalLauncherEnvironment,
  type GlobalLauncherMutationPoint,
} from "../src/installation/global-launcher.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Pi-owned global launcher installation", () => {
  it("activates beside the sole Pi executable and records authenticated ownership", async () => {
    const fixture = await piUserPackageFixture("active");

    expect(
      isPiUserPackageInstallation({
        packageRoot: fixture.environment.packageRoot,
        agentDir: fixture.environment.agentDir,
      }),
    ).toBe(true);

    const activation = await activateGlobalLauncher(fixture.environment);

    expect(activation?.launcherPath).toBe(path.join(fixture.piBin, "koni"));
    expect(await realpath(activation!.launcherPath)).toBe(await realpath(fixture.coreLauncher));
    expect(JSON.parse(await readFile(fixture.markerPath, "utf8"))).toMatchObject({
      protocol: "koni.global-launcher.v1",
      launcherPath: path.join(fixture.piBin, "koni"),
      packageRoot: fixture.environment.packageRoot,
    });
  });

  it("does nothing for an ordinary workspace package", async () => {
    const root = await temporaryRoot("workspace");
    const agentDir = path.join(root, "agent");
    const packageRoot = path.join(root, "packages", "core");
    const piBin = path.join(root, "bin");
    const coreLauncher = path.join(packageRoot, "bin", "koni.js");
    await Promise.all([
      mkdir(path.dirname(coreLauncher), { recursive: true }),
      mkdir(agentDir, { recursive: true }),
      mkdir(piBin, { recursive: true }),
    ]);
    await writeFile(coreLauncher, "#!/usr/bin/env node\n", { mode: 0o755 });
    await writeExecutable(path.join(piBin, "pi"));
    const environment: GlobalLauncherEnvironment = {
      packageRoot,
      agentDir,
      pathValue: piBin,
      platform: "linux",
    };

    expect(isPiUserPackageInstallation({ packageRoot, agentDir })).toBe(false);
    await expect(activateGlobalLauncher(environment)).resolves.toBeUndefined();
    await expect(readFile(path.join(piBin, "koni"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(path.join(agentDir, "koni", "global-launcher.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to replace a launcher that has no authenticated ownership marker", async () => {
    const fixture = await piUserPackageFixture("collision");
    const launcherPath = path.join(fixture.piBin, "koni");
    await writeFile(launcherPath, "unrelated launcher\n", { mode: 0o755 });

    await expect(activateGlobalLauncher(fixture.environment)).rejects.toThrow(
      /refusing to overwrite an unrelated koni launcher/u,
    );
    expect(await readFile(launcherPath, "utf8")).toBe("unrelated launcher\n");
  });

  it("refuses ambiguous Pi executables without publishing ownership state", async () => {
    const fixture = await piUserPackageFixture("ambiguous-pi");
    const secondBin = path.join(fixture.root, "second-bin");
    await mkdir(secondBin);
    await writeExecutable(path.join(secondBin, "pi"));
    const environment = {
      ...fixture.environment,
      pathValue: `${fixture.piBin}:${secondBin}`,
    };

    await expect(activateGlobalLauncher(environment)).rejects.toThrow(/ambiguous Pi/u);
    await expect(readFile(fixture.markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses package and marker symlink escapes", async () => {
    const root = await temporaryRoot("symlink-escape");
    const agentDir = path.join(root, "agent");
    const externalNpm = path.join(root, "external-npm");
    const packageRoot = path.join(agentDir, "npm", "node_modules", "@koni", "core");
    await Promise.all([mkdir(agentDir), mkdir(externalNpm)]);
    await symlink(externalNpm, path.join(agentDir, "npm"), "dir");
    await mkdir(path.join(externalNpm, "node_modules", "@koni", "core", "bin"), {
      recursive: true,
    });

    expect(isPiUserPackageInstallation({ packageRoot, agentDir })).toBe(false);

    const fixture = await piUserPackageFixture("marker-symlink");
    const externalMarker = path.join(fixture.root, "external-marker");
    await mkdir(externalMarker);
    await symlink(externalMarker, path.join(fixture.environment.agentDir, "koni"), "dir");
    await expect(activateGlobalLauncher(fixture.environment)).rejects.toThrow(/marker directory/u);
  });

  it("refuses malformed ownership markers and unrelated owned-path replacements", async () => {
    const malformed = await piUserPackageFixture("malformed-marker");
    await mkdir(path.dirname(malformed.markerPath), { recursive: true });
    await writeFile(malformed.markerPath, "{not-json\n", { mode: 0o600 });
    await expect(activateGlobalLauncher(malformed.environment)).rejects.toThrow(/malformed/u);

    const replaced = await piUserPackageFixture("replaced-launcher");
    await activateGlobalLauncher(replaced.environment);
    const unrelatedTarget = path.join(replaced.root, "unrelated-target");
    await writeExecutable(unrelatedTarget);
    const launcherPath = path.join(replaced.piBin, "koni");
    await unlink(launcherPath);
    await symlink(unrelatedTarget, launcherPath);
    await expect(activateGlobalLauncher(replaced.environment)).rejects.toThrow(
      /unrelated koni launcher/u,
    );
    expect(await realpath(launcherPath)).toBe(await realpath(unrelatedTarget));
  });

  it("refuses unwritable launcher and existing marker directories before publication", async () => {
    const launcherFixture = await piUserPackageFixture("unwritable-launcher");
    await chmod(launcherFixture.piBin, 0o500);
    try {
      await expect(activateGlobalLauncher(launcherFixture.environment)).rejects.toThrow(
        /not writable/u,
      );
      await expect(
        readFile(
          path.join(launcherFixture.environment.agentDir, "koni", "global-launcher.pending.json"),
          "utf8",
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(launcherFixture.piBin, 0o700);
    }

    const markerFixture = await piUserPackageFixture("unwritable-marker");
    const markerDirectory = path.dirname(markerFixture.markerPath);
    await mkdir(markerDirectory, { recursive: true });
    await chmod(markerDirectory, 0o500);
    try {
      await expect(activateGlobalLauncher(markerFixture.environment)).rejects.toThrow(
        /not writable/u,
      );
      await expect(readFile(path.join(markerFixture.piBin, "koni"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await chmod(markerDirectory, 0o700);
    }
  });

  it("publishes an exact Windows command shim bound by the marker", async () => {
    const fixture = await piUserPackageFixture("windows-shim");
    fixture.environment.platform = "win32";
    await writeFile(path.join(fixture.piBin, "pi.cmd"), "@ECHO off\r\n");

    const activation = await activateGlobalLauncher(fixture.environment);

    expect(activation?.launcherPath).toBe(path.join(fixture.piBin, "koni.cmd"));
    expect(await readFile(activation!.launcherPath, "utf8")).toBe(
      `@node "${fixture.coreLauncher}" %*\r\n`,
    );
  });

  it("treats a standard npm Windows shim family as one Pi installation", async () => {
    const fixture = await piUserPackageFixture("windows-npm-family");
    fixture.environment.platform = "win32";
    await writeFile(path.join(fixture.piBin, "pi.cmd"), "@ECHO off\r\nnode pi-cli.js %*\r\n");
    await writeFile(path.join(fixture.piBin, "pi.ps1"), "& node pi-cli.js $args\r\n");

    const activation = await activateGlobalLauncher(fixture.environment);

    expect(activation?.launcherPath).toBe(path.join(fixture.piBin, "koni.cmd"));
  });

  it("still rejects genuinely distinct Windows Pi installations", async () => {
    const fixture = await piUserPackageFixture("windows-distinct");
    fixture.environment.platform = "win32";
    await writeFile(path.join(fixture.piBin, "pi.cmd"), "@ECHO off\r\n");
    const secondBin = path.join(fixture.root, "windows-second-bin");
    await mkdir(secondBin);
    await writeFile(path.join(secondBin, "pi.cmd"), "@ECHO off\r\n");
    fixture.environment.pathValue = `${fixture.piBin};${secondBin}`;

    await expect(activateGlobalLauncher(fixture.environment)).rejects.toThrow(/ambiguous Pi/u);
  });

  it("updates an authenticated launcher and treats same-generation activation as idempotent", async () => {
    const fixture = await piUserPackageFixture("old");
    const oldActivation = await activateGlobalLauncher(fixture.environment);
    const newGeneration = await addPackageGeneration(fixture, "new");

    const first = await activateGlobalLauncher(newGeneration.environment);
    const second = await activateGlobalLauncher(newGeneration.environment);

    expect(first).toEqual(second);
    expect(first?.targetSha256).not.toBe(oldActivation?.targetSha256);
    expect(await realpath(first!.launcherPath)).toBe(await realpath(newGeneration.coreLauncher));
    expect(JSON.parse(await readFile(fixture.markerPath, "utf8"))).toEqual(first);
  });

  it("does not overwrite a launcher replaced after update authentication", async () => {
    const fixture = await piUserPackageFixture("update-race-old");
    const previous = await activateGlobalLauncher(fixture.environment);
    const next = await addPackageGeneration(fixture, "update-race-next");
    const launcherPath = previous!.launcherPath;
    const racedEnvironment = {
      ...next.environment,
      [GLOBAL_LAUNCHER_TEST_HOOK]: async (point: GlobalLauncherMutationPoint) => {
        if (point !== "before_launcher_rename") return;
        await unlink(launcherPath);
        await writeFile(launcherPath, "unrelated update race\n", { mode: 0o755 });
      },
    };

    await expect(activateGlobalLauncher(racedEnvironment)).rejects.toThrow(
      /unrelated koni launcher/u,
    );
    expect(await readFile(launcherPath, "utf8")).toBe("unrelated update race\n");
    expect(JSON.parse(await readFile(fixture.markerPath, "utf8"))).toEqual(previous);
  });

  it("never deletes a quarantine replaced after update validation", async () => {
    const fixture = await piUserPackageFixture("update-quarantine-race");
    const previous = await activateGlobalLauncher(fixture.environment);
    const next = await addPackageGeneration(fixture, "update-quarantine-next");
    let quarantinePath: string | undefined;
    const racedEnvironment = {
      ...next.environment,
      [GLOBAL_LAUNCHER_TEST_HOOK]: async (point: GlobalLauncherMutationPoint) => {
        if (point !== "after_launcher_displaced_validation") return;
        quarantinePath = await replaceQuarantineWithUnrelated(
          fixture.piBin,
          previous!.launcherTarget,
          "unrelated update quarantine\n",
        );
      },
    };

    await expect(activateGlobalLauncher(racedEnvironment)).resolves.toBeDefined();
    expect(quarantinePath).toBeDefined();
    expect(await readFile(quarantinePath!, "utf8")).toBe("unrelated update quarantine\n");
  });

  it("removes only the generation that currently owns the launcher", async () => {
    const fixture = await piUserPackageFixture("old-removal");
    await activateGlobalLauncher(fixture.environment);
    const current = await addPackageGeneration(fixture, "current-removal");
    await activateGlobalLauncher(current.environment);

    await expect(removeGlobalLauncher(fixture.environment)).resolves.toBe("not_owner");
    await expect(removeGlobalLauncher(current.environment)).resolves.toBe("removed");
    await expect(removeGlobalLauncher(current.environment)).resolves.toBe("absent");
    await expect(readFile(path.join(fixture.piBin, "koni"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(fixture.markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not unlink a launcher replaced after removal authentication", async () => {
    const fixture = await piUserPackageFixture("removal-race");
    const activation = await activateGlobalLauncher(fixture.environment);
    const racedEnvironment = {
      ...fixture.environment,
      [GLOBAL_LAUNCHER_TEST_HOOK]: async (point: GlobalLauncherMutationPoint) => {
        if (point !== "before_launcher_unlink") return;
        await unlink(activation!.launcherPath);
        await writeFile(activation!.launcherPath, "unrelated removal race\n", { mode: 0o755 });
      },
    };

    await expect(removeGlobalLauncher(racedEnvironment)).resolves.toBe("not_owner");
    expect(await readFile(activation!.launcherPath, "utf8")).toBe("unrelated removal race\n");
    expect(JSON.parse(await readFile(fixture.markerPath, "utf8"))).toEqual(activation);
  });

  it("never deletes a quarantine replaced after removal validation", async () => {
    const fixture = await piUserPackageFixture("removal-quarantine-race");
    const activation = await activateGlobalLauncher(fixture.environment);
    let quarantinePath: string | undefined;
    const racedEnvironment = {
      ...fixture.environment,
      [GLOBAL_LAUNCHER_TEST_HOOK]: async (point: GlobalLauncherMutationPoint) => {
        if (point !== "after_launcher_removal_validation") return;
        quarantinePath = await replaceQuarantineWithUnrelated(
          fixture.piBin,
          activation!.launcherTarget,
          "unrelated removal quarantine\n",
        );
      },
    };

    await expect(removeGlobalLauncher(racedEnvironment)).resolves.toBe("removed");
    expect(quarantinePath).toBeDefined();
    expect(await readFile(quarantinePath!, "utf8")).toBe("unrelated removal quarantine\n");
  });

  it("does not follow a replaced marker directory during removal", async () => {
    const fixture = await piUserPackageFixture("removal-marker-escape");
    await activateGlobalLauncher(fixture.environment);
    const markerBytes = await readFile(fixture.markerPath, "utf8");
    const markerDirectory = path.dirname(fixture.markerPath);
    const displacedDirectory = path.join(fixture.root, "displaced-marker");
    const externalDirectory = path.join(fixture.root, "external-marker-removal");
    await rename(markerDirectory, displacedDirectory);
    await mkdir(externalDirectory);
    const externalMarker = path.join(externalDirectory, "global-launcher.json");
    await writeFile(externalMarker, markerBytes, { mode: 0o600 });
    await symlink(externalDirectory, markerDirectory, "dir");

    await expect(removeGlobalLauncher(fixture.environment)).resolves.toBe("not_owner");
    expect(await readFile(externalMarker, "utf8")).toBe(markerBytes);
    expect(await realpath(path.join(fixture.piBin, "koni"))).toBe(
      await realpath(fixture.coreLauncher),
    );
  });

  it.each([
    "before_launcher_rename",
    "after_launcher_rename",
    "before_marker_rename",
    "after_marker_rename",
  ] satisfies GlobalLauncherMutationPoint[])(
    "recovers an authenticated update interrupted %s",
    async (interruption) => {
      const fixture = await piUserPackageFixture(`interruption-${interruption}`);
      await activateGlobalLauncher(fixture.environment);
      const next = await addPackageGeneration(fixture, `next-${interruption}`);
      const interruptedEnvironment = {
        ...next.environment,
        [GLOBAL_LAUNCHER_TEST_HOOK]: async (point: GlobalLauncherMutationPoint) => {
          if (point === interruption) throw new Error(`simulated crash ${point}`);
        },
      };

      await expect(activateGlobalLauncher(interruptedEnvironment)).rejects.toThrow(
        `simulated crash ${interruption}`,
      );

      const recovered = await activateGlobalLauncher(next.environment);
      expect(await realpath(recovered!.launcherPath)).toBe(await realpath(next.coreLauncher));
      expect(JSON.parse(await readFile(fixture.markerPath, "utf8"))).toEqual(recovered);
    },
  );

  it("never consumes a pending update as authority over an unrelated launcher", async () => {
    const fixture = await piUserPackageFixture("interrupted-collision");
    await activateGlobalLauncher(fixture.environment);
    const next = await addPackageGeneration(fixture, "interrupted-collision-next");
    const interruptedEnvironment = {
      ...next.environment,
      [GLOBAL_LAUNCHER_TEST_HOOK]: async (point: GlobalLauncherMutationPoint) => {
        if (point === "before_launcher_rename") throw new Error("simulated crash");
      },
    };
    await expect(activateGlobalLauncher(interruptedEnvironment)).rejects.toThrow("simulated crash");
    const launcherPath = path.join(fixture.piBin, "koni");
    await unlink(launcherPath);
    await writeFile(launcherPath, "unrelated after interruption\n", { mode: 0o755 });

    await expect(activateGlobalLauncher(next.environment)).rejects.toThrow(
      /refusing to overwrite an unrelated koni launcher/u,
    );
    expect(await readFile(launcherPath, "utf8")).toBe("unrelated after interruption\n");
  });

  it.each(["previous", "next"] as const)(
    "refuses recovery when the %s journal target physically escapes its package",
    async (escapedGeneration) => {
      const fixture = await piUserPackageFixture(`recovery-${escapedGeneration}-escape`);
      const previous = await activateGlobalLauncher(fixture.environment);
      const next = await addPackageGeneration(fixture, `recovery-${escapedGeneration}-next`);
      const interruptedEnvironment = {
        ...next.environment,
        [GLOBAL_LAUNCHER_TEST_HOOK]: async (point: GlobalLauncherMutationPoint) => {
          if (point === "before_launcher_rename") throw new Error("seed pending journal");
        },
      };
      await expect(activateGlobalLauncher(interruptedEnvironment)).rejects.toThrow(
        "seed pending journal",
      );
      const escapedPackageRoot =
        escapedGeneration === "previous"
          ? fixture.environment.packageRoot
          : next.environment.packageRoot;
      await replacePackageBinWithExternalIdentical(
        escapedPackageRoot,
        path.join(fixture.root, `external-${escapedGeneration}-bin`),
      );

      await expect(removeGlobalLauncher(next.environment)).rejects.toThrow(/escapes its package/u);
      expect(await readlink(previous!.launcherPath)).toBe(previous!.launcherTarget);
      expect(JSON.parse(await readFile(fixture.markerPath, "utf8"))).toEqual(previous);
    },
  );

  it("rejects a recovery target swapped between containment and digest authentication", async () => {
    const fixture = await piUserPackageFixture("recovery-auth-swap");
    const previous = await activateGlobalLauncher(fixture.environment);
    const next = await addPackageGeneration(fixture, "recovery-auth-swap-next");
    const interruptedEnvironment = {
      ...next.environment,
      [GLOBAL_LAUNCHER_TEST_HOOK]: async (point: GlobalLauncherMutationPoint) => {
        if (point === "before_launcher_rename") throw new Error("seed pending journal");
      },
    };
    await expect(activateGlobalLauncher(interruptedEnvironment)).rejects.toThrow(
      "seed pending journal",
    );
    const recoveryEnvironment = {
      ...next.environment,
      [GLOBAL_LAUNCHER_TEST_HOOK]: async (point: GlobalLauncherMutationPoint) => {
        if (point !== "after_recovery_target_containment") return;
        await replacePackageBinWithExternalIdentical(
          next.environment.packageRoot,
          path.join(fixture.root, "external-auth-swap-bin"),
        );
      },
    };

    await expect(removeGlobalLauncher(recoveryEnvironment)).rejects.toThrow(
      /changed during authentication|escapes its package/u,
    );
    expect(await readlink(previous!.launcherPath)).toBe(previous!.launcherTarget);
    expect(JSON.parse(await readFile(fixture.markerPath, "utf8"))).toEqual(previous);
  });

  it("runs the lifecycle adapter as a no-op outside a Pi user-package install", async () => {
    const root = await temporaryRoot("lifecycle-noop");
    const agentDir = path.join(root, "agent");
    const piBin = path.join(root, "bin");
    await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(piBin, { recursive: true })]);
    await writeExecutable(path.join(piBin, "pi"));
    const result = await runLifecycle("activate", agentDir, piBin);

    expect(result).toEqual({ code: 0, stderr: "" });
    await expect(readFile(path.join(piBin, "koni"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects unsupported lifecycle actions with an actionable error", async () => {
    const root = await temporaryRoot("lifecycle-action");
    const result = await runLifecycle("upgrade", path.join(root, "agent"), path.join(root, "bin"));

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/expected activate or remove/u);
  });
});

async function piUserPackageFixture(label: string): Promise<{
  coreLauncher: string;
  environment: GlobalLauncherEnvironment;
  markerPath: string;
  piBin: string;
  root: string;
}> {
  const root = await temporaryRoot(label);
  const agentDir = path.join(root, "agent");
  const packageRoot = path.join(agentDir, "npm", "node_modules", "@koni", "core");
  const coreLauncher = path.join(packageRoot, "bin", "koni.js");
  const piBin = path.join(root, "bin");
  await Promise.all([
    mkdir(path.dirname(coreLauncher), { recursive: true }),
    mkdir(piBin, { recursive: true }),
  ]);
  await writeFile(coreLauncher, `#!/usr/bin/env node\n// ${label}\n`, { mode: 0o755 });
  await writeExecutable(path.join(piBin, "pi"));
  return {
    coreLauncher,
    environment: {
      packageRoot,
      agentDir,
      pathValue: piBin,
      platform: "linux",
    },
    markerPath: path.join(agentDir, "koni", "global-launcher.json"),
    piBin,
    root,
  };
}

async function addPackageGeneration(
  fixture: Awaited<ReturnType<typeof piUserPackageFixture>>,
  label: string,
): Promise<{ coreLauncher: string; environment: GlobalLauncherEnvironment }> {
  const packageRoot = path.join(fixture.environment.packageRoot, "generations", label);
  const coreLauncher = path.join(packageRoot, "bin", "koni.js");
  await mkdir(path.dirname(coreLauncher), { recursive: true });
  await writeFile(coreLauncher, `#!/usr/bin/env node\n// ${label}\n`, { mode: 0o755 });
  return {
    coreLauncher,
    environment: { ...fixture.environment, packageRoot },
  };
}

async function temporaryRoot(label: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `koni-global-${label}-`)));
  temporaryRoots.push(root);
  return root;
}

async function writeExecutable(destination: string): Promise<void> {
  await writeFile(destination, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(destination, 0o755);
}

async function replacePackageBinWithExternalIdentical(
  packageRoot: string,
  externalBin: string,
): Promise<void> {
  const packageBin = path.join(packageRoot, "bin");
  const launcherBytes = await readFile(path.join(packageBin, "koni.js"));
  await rename(packageBin, path.join(packageRoot, "displaced-bin"));
  await mkdir(externalBin, { recursive: true });
  await writeFile(path.join(externalBin, "koni.js"), launcherBytes, { mode: 0o755 });
  await symlink(externalBin, packageBin, "dir");
}

async function replaceQuarantineWithUnrelated(
  directory: string,
  expectedTarget: string,
  bytes: string,
): Promise<string> {
  for (const entry of await readdir(directory)) {
    const candidate = path.join(directory, entry);
    try {
      if ((await readlink(candidate)) !== expectedTarget) continue;
      await unlink(candidate);
      await writeFile(candidate, bytes, { mode: 0o755 });
      return candidate;
    } catch {
      // The publication temp or an unrelated directory entry is not the owned quarantine.
    }
  }
  throw new Error("owned launcher quarantine not found");
}

async function runLifecycle(
  action: string,
  agentDir: string,
  pathValue: string,
): Promise<{ code: number | null; stderr: string }> {
  const packageRoot = path.resolve(import.meta.dirname, "..");
  const child = spawn(
    process.execPath,
    [path.join(packageRoot, "bin", "koni-package-lifecycle.js"), action],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        PATH: pathValue,
        PI_CODING_AGENT_DIR: agentDir,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stderr };
}
