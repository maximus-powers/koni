import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeInstallationEnvironment,
  activeInstallationFromEnvironment,
  assertActiveInstallationCurrent,
  bindVersionedActiveInstallation,
  KONI_ACTIVE_INSTALL_LAUNCHER_ENV,
  waitForActiveInstallationSupersession,
} from "../src/runtime/active-installation.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("active Koni installation binding", () => {
  it("rejects a versioned runtime after the active launcher moves to another bundle", async () => {
    const fixture = await versionedInstall();
    const binding = await bindVersionedActiveInstallation(fixture.firstLauncher);

    expect(binding).toEqual({
      activeLauncherPath: fixture.activeLauncher,
      expectedLauncherPath: fixture.firstLauncher,
    });
    await expect(assertActiveInstallationCurrent(binding!)).resolves.toBeUndefined();

    await replaceSymlink(fixture.activeLauncher, fixture.secondLauncher);

    await expect(assertActiveInstallationCurrent(binding!)).rejects.toMatchObject({
      code: "core_install_superseded",
    });
  });

  it("does not impose a global launcher on a non-versioned source runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "koni-source-runtime-"));
    roots.push(root);
    const launcher = path.join(root, "packages", "core", "bin", "koni.js");
    await mkdir(path.dirname(launcher), { recursive: true });
    await writeFile(launcher, "#!/usr/bin/env node\n", "utf8");

    await expect(bindVersionedActiveInstallation(launcher)).resolves.toBeUndefined();
  });

  it("observes an atomic activation change and permits monitor cancellation", async () => {
    const fixture = await versionedInstall();
    const binding = (await bindVersionedActiveInstallation(fixture.firstLauncher))!;
    const observed = waitForActiveInstallationSupersession(binding, { pollIntervalMs: 5 });

    await replaceSymlink(fixture.activeLauncher, fixture.secondLauncher);
    await expect(observed).resolves.toBeUndefined();

    const controller = new AbortController();
    const cancelled = waitForActiveInstallationSupersession(
      (await bindVersionedActiveInstallation(fixture.secondLauncher))!,
      { pollIntervalMs: 5, signal: controller.signal },
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  });

  it("round-trips a complete daemon binding and rejects a partial environment", async () => {
    const fixture = await versionedInstall();
    const binding = (await bindVersionedActiveInstallation(fixture.firstLauncher))!;

    expect(activeInstallationFromEnvironment(activeInstallationEnvironment(binding))).toEqual(
      binding,
    );
    expect(() =>
      activeInstallationFromEnvironment({
        [KONI_ACTIVE_INSTALL_LAUNCHER_ENV]: binding.activeLauncherPath,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "core_install_binding",
      }),
    );
  });
});

async function versionedInstall(): Promise<{
  activeLauncher: string;
  firstLauncher: string;
  secondLauncher: string;
}> {
  const prefix = await realpath(await mkdtemp(path.join(tmpdir(), "koni-active-install-")));
  roots.push(prefix);
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
  return { activeLauncher, firstLauncher, secondLauncher };
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

async function replaceSymlink(link: string, target: string): Promise<void> {
  const replacement = `${link}.new`;
  await symlink(target, replacement);
  await rename(replacement, link);
}
