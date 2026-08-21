import fs from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ProfileBaselineFile,
  ProfilePackageManifest,
} from "../src/contracts/profile-package.js";
import { computeProfileBundleSha256 } from "../src/compiler/profile-package.js";
import { FileTransactionStore } from "../src/authority/file-journal.js";
import {
  installProfile,
  previewProfileInstall,
  readProfileLifecycle,
  REQUIRED_SUPERPOWERS_PI_PACKAGE,
  type ProfileInstallError,
} from "../src/profile/install.js";
import { rawSha256 } from "../src/shared/canonical.js";

const roots: string[] = [];
const codingProfile = path.resolve(import.meta.dirname, "../../coding-profile");
const legacySuperpowersPackage = "git:github.com/obra/superpowers";
const piSettingsTransitionProtocol = "koni.pi-settings-transition.v1";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}, 30_000);

describe("profile installation and guarded upgrades", () => {
  it("pins the required Superpowers package to the reviewed upstream commit", () => {
    expect(REQUIRED_SUPERPOWERS_PI_PACKAGE).toBe(
      "git:github.com/obra/superpowers@b36e0829c6d0140e93cfef2ca599b1b07d4a7797",
    );
  });

  it("materializes a verified profile and merges the required Pi package", async () => {
    const project = await temporary("project");
    await mkdir(path.join(project, ".pi"), { recursive: true });
    await mkdir(path.join(project, ".agents", "skills", "community"), { recursive: true });
    await writeFile(path.join(project, ".pi", "settings.json"), '{"theme":"user-owned"}\n');
    await writeFile(path.join(project, ".pi", "auth.json"), '{"credential":"user-owned"}\n');
    await writeFile(
      path.join(project, ".agents", "skills", "community", "SKILL.md"),
      "user owned\n",
    );
    const result = await installProfile(project, codingProfile);
    expect(result.packageName).toBe("@koni/coding-profile");
    expect(result.added).toContain("project.yaml");
    expect(JSON.parse(await readFile(path.join(project, ".pi", "settings.json"), "utf8"))).toEqual({
      theme: "user-owned",
      packages: [REQUIRED_SUPERPOWERS_PI_PACKAGE],
    });
    expect(await readFile(path.join(project, ".pi", "auth.json"), "utf8")).toBe(
      '{"credential":"user-owned"}\n',
    );
    expect(
      await readFile(path.join(project, ".agents", "skills", "community", "SKILL.md"), "utf8"),
    ).toBe("user owned\n");
    expect(await readFile(path.join(project, ".koni", "project.yaml"), "utf8")).toContain(
      "Software project",
    );
    const lifecycle = await readProfileLifecycle(project);
    expect(lifecycle?.immutableBaselines).toHaveLength(1);
    const storedRoot = path.join(project, ".koni", lifecycle!.immutableBaselines[0]!.root);
    expect(await readFile(path.join(storedRoot, "profile-manifest.json"), "utf8")).toContain(
      result.bundleSha256,
    );
  }, 30_000);

  it("preserves a pre-existing required Pi package without duplicating it", async () => {
    const project = await temporary("project");
    await mkdir(path.join(project, ".pi"), { recursive: true });
    await writeFile(
      path.join(project, ".pi", "settings.json"),
      `${JSON.stringify({ packages: [REQUIRED_SUPERPOWERS_PI_PACKAGE], theme: "user-owned" })}\n`,
    );

    await installProfile(project, codingProfile);

    expect(JSON.parse(await readFile(path.join(project, ".pi", "settings.json"), "utf8"))).toEqual({
      packages: [REQUIRED_SUPERPOWERS_PI_PACKAGE],
      theme: "user-owned",
    });
  }, 30_000);

  it("fails closed when the Koni-owned Pi package entry was changed", async () => {
    const project = await temporary("project");
    await installProfile(project, codingProfile);
    const settingsPath = path.join(project, ".pi", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { packages: string[] };
    settings.packages[0] = "git:github.com/obra/superpowers@user-ref";
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

    await expect(installProfile(project, codingProfile)).rejects.toMatchObject({
      code: "pi_settings_conflict",
    } satisfies Partial<ProfileInstallError>);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(settings);
  }, 30_000);

  it("atomically migrates the exact Koni-owned legacy Superpowers entry", async () => {
    const project = await legacyKoniOwnedPiPackageProject();
    const settingsPath = path.join(project, ".pi", "settings.json");

    await installProfile(project, codingProfile);

    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      theme: "user-owned",
      packages: ["user-package-before", REQUIRED_SUPERPOWERS_PI_PACKAGE, "user-package-after"],
    });
    expect(
      JSON.parse(
        await readFile(path.join(project, ".koni", ".managed", "pi-settings.json"), "utf8"),
      ),
    ).toEqual({
      protocol: "koni.pi-settings-ownership.v1",
      source: REQUIRED_SUPERPOWERS_PI_PACKAGE,
      managed: true,
    });
  }, 30_000);

  it.each([
    {
      name: "user-owned legacy entry",
      packages: [legacySuperpowersPackage],
      managed: false,
    },
    {
      name: "filtered legacy entry",
      packages: [{ source: legacySuperpowersPackage, skills: ["skills/using-superpowers/**"] }],
      managed: true,
    },
    {
      name: "object-shaped legacy entry",
      packages: [{ source: legacySuperpowersPackage }],
      managed: true,
    },
    {
      name: "user re-pin",
      packages: ["git:github.com/obra/superpowers@user-ref"],
      managed: true,
    },
    {
      name: "duplicate legacy entries",
      packages: [legacySuperpowersPackage, legacySuperpowersPackage],
      managed: true,
    },
    {
      name: "removed legacy entry",
      packages: [],
      managed: true,
    },
  ])("rejects $name instead of widening the legacy migration", async ({ packages, managed }) => {
    const project = await temporary("project");
    await installProfile(project, codingProfile);
    const settingsPath = path.join(project, ".pi", "settings.json");
    const ownershipPath = path.join(project, ".koni", ".managed", "pi-settings.json");
    const installPath = path.join(project, ".koni", ".managed", "install.json");
    await writeFile(settingsPath, `${JSON.stringify({ packages, theme: "user-owned" })}\n`);
    await writeFile(
      ownershipPath,
      `${JSON.stringify({
        protocol: "koni.pi-settings-ownership.v1",
        source: legacySuperpowersPackage,
        managed,
      })}\n`,
    );
    const settingsBefore = await readFile(settingsPath);
    const ownershipBefore = await readFile(ownershipPath);
    const installBefore = await readFile(installPath);

    await expect(installProfile(project, codingProfile)).rejects.toMatchObject({
      code: "pi_settings_conflict",
    } satisfies Partial<ProfileInstallError>);
    expect(await readFile(settingsPath)).toEqual(settingsBefore);
    expect(await readFile(ownershipPath)).toEqual(ownershipBefore);
    expect(await readFile(installPath)).toEqual(installBefore);
  });

  it.each(["initial", "legacy"] as const)(
    "cold-recovers every %s Pi-settings crash boundary",
    async (kind) => {
      for (const boundary of [
        "before_external_rename",
        "after_external_rename",
        "before_internal_commit",
        "after_internal_commit",
      ] as const) {
        const fixture = await piSettingsCrashFixture(kind, boundary);
        if (boundary === "before_external_rename" || boundary === "after_external_rename") {
          await expect(stat(fixture.mainTransactionPath)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect((await stat(fixture.mainTransactionPath)).isDirectory()).toBe(true);
        }

        await installProfile(fixture.project, codingProfile);

        expect(await readFile(fixture.settingsPath)).toEqual(fixture.desiredSettingsBytes);
        expect(await readFile(fixture.ownershipPath)).toEqual(fixture.desiredOwnershipBytes);
        await expect(stat(fixture.transitionPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(stat(fixture.mainTransactionPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(JSON.parse(await readFile(fixture.settingsPath, "utf8")).packages).toContain(
          REQUIRED_SUPERPOWERS_PI_PACKAGE,
        );
      }
    },
    30_000,
  );

  it("preserves an unrelated Pi-settings change and its recovery authority", async () => {
    const fixture = await piSettingsCrashFixture("legacy", "overlapping_main_prepared");
    const unrelatedSettings = Buffer.from(
      `${JSON.stringify({ packages: [legacySuperpowersPackage], theme: "changed-after-prepare" })}\n`,
    );
    await writeFile(fixture.settingsPath, unrelatedSettings);
    const transitionBefore = await readFile(fixture.transitionPath);
    const journalPath = path.join(
      fixture.project,
      ".koni",
      ".transactions",
      "profile-crash-main",
      "journal.json",
    );
    const journalBefore = await readFile(journalPath);

    await expect(installProfile(fixture.project, codingProfile)).rejects.toMatchObject({
      code: "pi_settings_changed",
    } satisfies Partial<ProfileInstallError>);
    expect(await readFile(fixture.settingsPath)).toEqual(unrelatedSettings);
    expect(await readFile(fixture.transitionPath)).toEqual(transitionBefore);
    expect(await readFile(journalPath)).toEqual(journalBefore);
  }, 30_000);

  it.each([
    {
      corruption: "ownership base64",
      mutate(authority: Record<string, unknown>) {
        authority.desiredOwnershipBase64 = "%%%not-base64%%%";
      },
    },
    {
      corruption: "ownership hash",
      mutate(authority: Record<string, unknown>) {
        authority.desiredOwnershipSha256 = rawSha256(Buffer.from("different ownership\n"));
      },
    },
    {
      corruption: "ownership payload binding",
      mutate(authority: Record<string, unknown>) {
        const payload = Buffer.from(
          `${JSON.stringify({
            protocol: "koni.pi-settings-ownership.v1",
            source: "git:github.com/obra/superpowers@different-ref",
            managed: true,
          })}\n`,
        );
        authority.desiredOwnershipSha256 = rawSha256(payload);
        authority.desiredOwnershipBase64 = payload.toString("base64");
      },
    },
    {
      corruption: "settings payload schema",
      mutate(authority: Record<string, unknown>) {
        const payload = Buffer.from('{"packages":"not-an-array"}\n');
        authority.desiredSettingsSha256 = rawSha256(payload);
        authority.desiredSettingsBase64 = payload.toString("base64");
      },
    },
  ])(
    "authenticates $corruption before changing either Pi target",
    async ({ mutate }) => {
      const fixture = await piSettingsCrashFixture("legacy", "corrupt_marker_with_main_prepared");
      const authority = JSON.parse(await readFile(fixture.transitionPath, "utf8")) as Record<
        string,
        unknown
      >;
      mutate(authority);
      await writeFile(fixture.transitionPath, `${JSON.stringify(authority, null, 2)}\n`);
      const journalPath = path.join(fixture.mainTransactionPath, "journal.json");
      const before = {
        settings: await readFile(fixture.settingsPath),
        ownership: await readFile(fixture.ownershipPath),
        transition: await readFile(fixture.transitionPath),
        journal: await readFile(journalPath),
      };

      await expect(installProfile(fixture.project, codingProfile)).rejects.toMatchObject({
        code: "pi_settings_transition_invalid",
      } satisfies Partial<ProfileInstallError>);
      expect(await readFile(fixture.settingsPath)).toEqual(before.settings);
      expect(await readFile(fixture.ownershipPath)).toEqual(before.ownership);
      expect(await readFile(fixture.transitionPath)).toEqual(before.transition);
      expect(await readFile(journalPath)).toEqual(before.journal);
    },
    30_000,
  );

  it("fsyncs the complete coordination namespace before the external settings rename", async () => {
    const project = await temporary("pi-settings-coordination-durability");
    const events: string[] = [];

    const result = await withFilesystemTrace(events, () => installProfile(project, codingProfile));

    const configRoot = normalizedTracePath(result.projectConfigRoot);
    const canonicalProject = path.dirname(configRoot);
    const managedRoot = path.join(configRoot, ".managed");
    const coordinationRoot = path.join(managedRoot, "pi-settings-coordination");
    const transactionRoot = path.join(coordinationRoot, ".transactions");
    const settingsPath = path.join(canonicalProject, ".pi", "settings.json");
    const externalRename = events.findIndex((event) => event.endsWith(`->${settingsPath}`));
    expect(externalRename).toBeGreaterThan(-1);
    expectOrderedEventsBefore(
      events,
      [
        `sync:${configRoot}`,
        `sync:${project}`,
        `sync:${managedRoot}`,
        `sync:${configRoot}`,
        `sync:${coordinationRoot}`,
        `sync:${managedRoot}`,
        `sync:${transactionRoot}`,
        `sync:${coordinationRoot}`,
      ],
      externalRename,
    );
  }, 30_000);

  it("re-establishes desired-target durability across repeated recovery crashes", async () => {
    const fixture = await piSettingsCrashFixture("legacy", "after_external_rename");
    const before = {
      settings: await readFile(fixture.settingsPath),
      ownership: await readFile(fixture.ownershipPath),
      transition: await readFile(fixture.transitionPath),
    };
    const canonicalSettingsPath = normalizedTracePath(fixture.settingsPath);
    const canonicalOwnershipPath = normalizedTracePath(fixture.ownershipPath);

    const fileSyncEvents: string[] = [];
    await expect(
      withFilesystemTrace(
        fileSyncEvents,
        () => installProfile(fixture.project, codingProfile),
        canonicalSettingsPath,
      ),
    ).rejects.toThrow("simulated crash after fsync");
    expect(fileSyncEvents).toContain(`sync:${canonicalSettingsPath}`);
    expect(await readFile(fixture.settingsPath)).toEqual(before.settings);
    expect(await readFile(fixture.ownershipPath)).toEqual(before.ownership);
    expect(await readFile(fixture.transitionPath)).toEqual(before.transition);

    const parentSyncEvents: string[] = [];
    const settingsParent = path.dirname(canonicalSettingsPath);
    await expect(
      withFilesystemTrace(
        parentSyncEvents,
        () => installProfile(fixture.project, codingProfile),
        settingsParent,
      ),
    ).rejects.toThrow("simulated crash after fsync");
    expectOrderedEventsBefore(parentSyncEvents, [
      `sync:${canonicalSettingsPath}`,
      `sync:${settingsParent}`,
    ]);
    expect(await readFile(fixture.settingsPath)).toEqual(before.settings);
    expect(await readFile(fixture.ownershipPath)).toEqual(before.ownership);
    expect(await readFile(fixture.transitionPath)).toEqual(before.transition);

    const recoveryEvents: string[] = [];
    await withFilesystemTrace(recoveryEvents, () => installProfile(fixture.project, codingProfile));
    const ownershipRename = recoveryEvents.findIndex((event) =>
      event.endsWith(`->${canonicalOwnershipPath}`),
    );
    expect(ownershipRename).toBeGreaterThan(-1);
    expectOrderedEventsBefore(
      recoveryEvents,
      [`sync:${canonicalSettingsPath}`, `sync:${settingsParent}`],
      ownershipRename,
    );
    expect(await readFile(fixture.settingsPath)).toEqual(fixture.desiredSettingsBytes);
    expect(await readFile(fixture.ownershipPath)).toEqual(fixture.desiredOwnershipBytes);
    await expect(stat(fixture.transitionPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("converges a pre-existing main journal only after its external transition", async () => {
    const fixture = await piSettingsCrashFixture("legacy", "overlapping_main_prepared");

    await installProfile(fixture.project, codingProfile);

    expect(await readFile(fixture.settingsPath)).toEqual(fixture.desiredSettingsBytes);
    expect(await readFile(fixture.ownershipPath)).toEqual(fixture.desiredOwnershipBytes);
    await expect(stat(fixture.transitionPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.mainTransactionPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("previews without creating a lock, transaction, or .koni tree", async () => {
    const project = await temporary("project");
    const preview = await previewProfileInstall(project, codingProfile);
    expect(preview.added).toContain("profile.yaml");
    await expect(stat(path.join(project, ".koni"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("does not call an ordinary project override an upstream conflict", async () => {
    const project = await temporary("project");
    await installProfile(project, codingProfile);
    const projectYaml = path.join(project, ".koni", "project.yaml");
    await writeFile(projectYaml, `${await readFile(projectYaml, "utf8")}# project override\n`);

    const packageCopy = await temporary("package");
    await cp(codingProfile, packageCopy, { recursive: true });
    // The same package is enough to prove modified local bytes are preserved;
    // no manifest mutation is permitted without recomputing its signed inventory.
    const result = await installProfile(project, packageCopy);
    expect(result.preserved).toContain("project.yaml");
    expect(await readFile(projectYaml, "utf8")).toContain("# project override");
    expect(result.pendingUpstream.find((item) => item.path === "project.yaml")).toBeUndefined();
  }, 30_000);

  it("three-way merges changed defaults while preserving edits, deletions, and additions", async () => {
    const project = await temporary("project");
    const v1 = await syntheticProfile("1.0.0", {
      "profile.yaml": "schema_version: '3.0'\nvalue: one\n",
      "edited.yaml": "value: old\n",
      "deleted.yaml": "value: old\n",
      "removed.yaml": "value: remove-me\n",
    });
    const v2 = await syntheticProfile("1.1.0", {
      "profile.yaml": "schema_version: '3.0'\nvalue: two\n",
      "edited.yaml": "value: upstream\n",
      "deleted.yaml": "value: upstream\n",
      "added.yaml": "value: new\n",
    });
    await installProfile(project, v1);
    await writeFile(path.join(project, ".koni", "edited.yaml"), "value: project\n");
    await rm(path.join(project, ".koni", "deleted.yaml"));
    await writeFile(path.join(project, ".koni", "custom.yaml"), "value: custom\n");
    const compatibilityRun = path.join(project, ".koni", "runs", "active-run", "run.json");
    const authorityRun = path.join(project, ".git", "koni", "runs", "active-run", "run.json");
    await mkdir(path.dirname(compatibilityRun), { recursive: true });
    await mkdir(path.dirname(authorityRun), { recursive: true });
    await writeFile(compatibilityRun, '{"phase":"paused","revision":7}\n');
    await writeFile(authorityRun, '{"phase":"paused","revision":7,"authority":true}\n');

    const result = await installProfile(project, v2);
    expect(await readFile(path.join(project, ".koni", "profile.yaml"), "utf8")).toContain(
      "value: two",
    );
    expect(await readFile(path.join(project, ".koni", "edited.yaml"), "utf8")).toBe(
      "value: project\n",
    );
    await expect(stat(path.join(project, ".koni", "deleted.yaml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(path.join(project, ".koni", "removed.yaml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(path.join(project, ".koni", "custom.yaml"), "utf8")).toBe(
      "value: custom\n",
    );
    expect(await readFile(path.join(project, ".koni", "added.yaml"), "utf8")).toBe("value: new\n");
    expect(await readFile(compatibilityRun, "utf8")).toBe('{"phase":"paused","revision":7}\n');
    expect(await readFile(authorityRun, "utf8")).toBe(
      '{"phase":"paused","revision":7,"authority":true}\n',
    );
    expect(result.pendingUpstream.map(({ path: relative, reason }) => [relative, reason])).toEqual([
      ["deleted.yaml", "deleted"],
      ["edited.yaml", "modified"],
    ]);
    expect(
      result.pendingUpstream.find((entry) => entry.path === "edited.yaml")?.conflictPaths,
    ).toEqual(["/value"]);
    expect(
      result.pendingUpstream.find((entry) => entry.path === "deleted.yaml")?.conflictPaths,
    ).toBeUndefined();
    expect(
      await readFile(path.join(project, ".koni", result.pendingUpstream[1]!.proposedPath), "utf8"),
    ).toBe("value: upstream\n");

    const repeated = await installProfile(project, v2);
    expect(repeated.pendingUpstream.map(({ path: relative }) => relative)).toEqual([
      "deleted.yaml",
      "edited.yaml",
    ]);
    const lifecycle = await readProfileLifecycle(project);
    expect(lifecycle?.immutableBaselines).toHaveLength(2);
    expect(
      lifecycle?.overlay.map(({ path: relative, disposition }) => [relative, disposition]),
    ).toEqual([
      ["custom.yaml", "added"],
      ["deleted.yaml", "deleted"],
      ["edited.yaml", "modified"],
    ]);
    expect(await readFile(compatibilityRun, "utf8")).toBe('{"phase":"paused","revision":7}\n');
    expect(await readFile(authorityRun, "utf8")).toBe(
      '{"phase":"paused","revision":7,"authority":true}\n',
    );
  }, 30_000);

  it("fails closed if immutable archived baseline bytes are changed", async () => {
    const project = await temporary("project");
    await installProfile(project, codingProfile);
    const lifecycle = (await readProfileLifecycle(project))!;
    const archive = path.join(
      project,
      ".koni",
      lifecycle.immutableBaselines[0]!.root,
      "profile-manifest.json",
    );
    await writeFile(archive, "corrupt\n");
    await expect(installProfile(project, codingProfile)).rejects.toMatchObject({
      code: "baseline_store_corrupt",
    } satisfies Partial<ProfileInstallError>);
  }, 30_000);

  it("recovers only a well-formed lock owned by a process that no longer exists", async () => {
    const project = await temporary("project");
    await mkdir(path.join(project, ".koni", ".managed"), { recursive: true });
    await writeFile(
      path.join(project, ".koni", ".managed", "profile-lifecycle.lock"),
      `${JSON.stringify({
        protocol: "koni.profile-lock.v1",
        pid: 2_147_483_647,
        nonce: "stale-test-lock",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const result = await installProfile(project, codingProfile);
    expect(result.added).toContain("profile.yaml");
    await expect(
      stat(path.join(project, ".koni", ".managed", "profile-lifecycle.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("rejects path-bearing install metadata before it can be used for an upgrade read", async () => {
    const project = await temporary("project");
    await installProfile(project, codingProfile);
    const installPath = path.join(project, ".koni", ".managed", "install.json");
    const install = JSON.parse(await readFile(installPath, "utf8")) as {
      baselineFiles: Array<{ path: string }>;
    };
    install.baselineFiles[0]!.path = "../../outside";
    await writeFile(installPath, `${JSON.stringify(install, null, 2)}\n`);
    await expect(installProfile(project, codingProfile)).rejects.toMatchObject({
      code: "install_record_invalid",
    } satisfies Partial<ProfileInstallError>);
  }, 30_000);

  it("refuses to overwrite an unmanaged .koni tree", async () => {
    const project = await temporary("project");
    await cp(codingProfile + "/koni/baseline", path.join(project, ".koni"), { recursive: true });
    await expect(installProfile(project, codingProfile)).rejects.toMatchObject({
      code: "unmanaged_project",
    } satisfies Partial<ProfileInstallError>);
  }, 30_000);
});

async function temporary(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `koni-${label}-`));
  roots.push(root);
  return root;
}

async function legacyKoniOwnedPiPackageProject(): Promise<string> {
  const project = await temporary("legacy-pi-package-project");
  await installProfile(project, codingProfile);
  await writeFile(
    path.join(project, ".pi", "settings.json"),
    `${JSON.stringify({
      theme: "user-owned",
      packages: ["user-package-before", legacySuperpowersPackage, "user-package-after"],
    })}\n`,
  );
  await writeFile(
    path.join(project, ".koni", ".managed", "pi-settings.json"),
    `${JSON.stringify({
      protocol: "koni.pi-settings-ownership.v1",
      source: legacySuperpowersPackage,
      managed: true,
    })}\n`,
  );
  return project;
}

async function piSettingsCrashFixture(
  kind: "initial" | "legacy",
  boundary:
    | "before_external_rename"
    | "after_external_rename"
    | "before_internal_commit"
    | "after_internal_commit"
    | "overlapping_main_prepared"
    | "corrupt_marker_with_main_prepared",
) {
  const project =
    kind === "legacy"
      ? await legacyKoniOwnedPiPackageProject()
      : await temporary("initial-pi-settings-crash");
  const settingsPath = path.join(project, ".pi", "settings.json");
  const ownershipPath = path.join(project, ".koni", ".managed", "pi-settings.json");
  if (kind === "initial") {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await mkdir(path.dirname(ownershipPath), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify({ theme: "user-owned" })}\n`);
  }
  const expectedSettingsBytes = await readFile(settingsPath);
  const expectedOwnershipBytes = kind === "legacy" ? await readFile(ownershipPath) : undefined;
  const desiredSettings = JSON.parse(expectedSettingsBytes.toString("utf8")) as {
    packages?: string[];
    theme: string;
  };
  if (kind === "legacy") {
    desiredSettings.packages = desiredSettings.packages!.map((entry) =>
      entry === legacySuperpowersPackage ? REQUIRED_SUPERPOWERS_PI_PACKAGE : entry,
    );
  } else {
    desiredSettings.packages = [REQUIRED_SUPERPOWERS_PI_PACKAGE];
  }
  const desiredSettingsBytes = Buffer.from(`${JSON.stringify(desiredSettings, null, 2)}\n`);
  const desiredOwnershipBytes = Buffer.from(
    `${JSON.stringify(
      {
        protocol: "koni.pi-settings-ownership.v1",
        source: REQUIRED_SUPERPOWERS_PI_PACKAGE,
        managed: true,
      },
      null,
      2,
    )}\n`,
  );
  const coordinationRoot = path.join(project, ".koni", ".managed", "pi-settings-coordination");
  const transitionPath = path.join(coordinationRoot, "transition.json");
  const mainTransactionPath = path.join(project, ".koni", ".transactions", "profile-crash-main");
  const transitionBytes = Buffer.from(
    `${JSON.stringify(
      {
        protocol: piSettingsTransitionProtocol,
        expectedSettingsSha256: rawSha256(expectedSettingsBytes),
        desiredSettingsSha256: rawSha256(desiredSettingsBytes),
        desiredSettingsBase64: desiredSettingsBytes.toString("base64"),
        expectedOwnershipSha256:
          expectedOwnershipBytes === undefined ? null : rawSha256(expectedOwnershipBytes),
        desiredOwnershipSha256: rawSha256(desiredOwnershipBytes),
        desiredOwnershipBase64: desiredOwnershipBytes.toString("base64"),
      },
      null,
      2,
    )}\n`,
  );
  const coordination = await FileTransactionStore.open(coordinationRoot);
  await coordination.prepare("pi-settings-crash-transition", [
    { path: "transition.json", bytes: transitionBytes, expectedSha256: null },
  ]);
  await coordination.commit("pi-settings-crash-transition");
  await coordination.cleanupCommitted("pi-settings-crash-transition");

  if (boundary !== "before_external_rename" && boundary !== "corrupt_marker_with_main_prepared") {
    await writeFile(settingsPath, desiredSettingsBytes);
  }
  if (boundary === "before_internal_commit" || boundary === "after_internal_commit") {
    await writeFile(ownershipPath, desiredOwnershipBytes);
    await rm(transitionPath);
    const main = await FileTransactionStore.open(path.join(project, ".koni"));
    await main.prepare("profile-crash-main", [
      {
        path: ".managed/crash-boundary.json",
        bytes: Buffer.from('{"prepared":true}\n'),
        expectedSha256: null,
      },
    ]);
    if (boundary === "after_internal_commit") await main.commit("profile-crash-main");
  }
  if (
    boundary === "overlapping_main_prepared" ||
    boundary === "corrupt_marker_with_main_prepared"
  ) {
    const main = await FileTransactionStore.open(path.join(project, ".koni"));
    await main.prepare("profile-crash-main", [
      {
        path: ".managed/pi-settings.json",
        bytes: desiredOwnershipBytes,
        expectedSha256:
          expectedOwnershipBytes === undefined ? null : rawSha256(expectedOwnershipBytes),
      },
    ]);
  }
  return {
    project,
    settingsPath,
    ownershipPath,
    transitionPath,
    mainTransactionPath,
    desiredSettingsBytes,
    desiredOwnershipBytes,
  };
}

async function withFilesystemTrace<T>(
  events: string[],
  operation: () => Promise<T>,
  failAfterSyncPath?: string,
): Promise<T> {
  const originalOpen = fs.promises.open;
  const originalRename = fs.promises.rename;
  const normalizedFailurePath =
    failAfterSyncPath === undefined ? undefined : normalizedTracePath(failAfterSyncPath);
  fs.promises.open = async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    const openedPath = normalizedTracePath(String(args[0]));
    const originalSync = handle.sync.bind(handle);
    handle.sync = async () => {
      await originalSync();
      events.push(`sync:${openedPath}`);
      if (openedPath === normalizedFailurePath) {
        throw new Error(`simulated crash after fsync: ${openedPath}`);
      }
    };
    return handle;
  };
  fs.promises.rename = async (...args: Parameters<typeof originalRename>) => {
    events.push(
      `rename:${normalizedTracePath(String(args[0]))}->${normalizedTracePath(String(args[1]))}`,
    );
    return originalRename(...args);
  };
  syncBuiltinESMExports();
  try {
    return await operation();
  } finally {
    fs.promises.open = originalOpen;
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
  }
}

function normalizedTracePath(filePath: string): string {
  return path.resolve(filePath).replace(/^\/private(?=\/var\/)/u, "");
}

function expectOrderedEventsBefore(
  events: readonly string[],
  expected: readonly string[],
  beforeIndex = events.length,
): void {
  let cursor = -1;
  for (const event of expected) {
    cursor = events.indexOf(event, cursor + 1);
    expect(cursor, `missing ordered filesystem event: ${event}`).toBeGreaterThan(-1);
    expect(cursor, `filesystem event occurred after the external boundary: ${event}`).toBeLessThan(
      beforeIndex,
    );
  }
}

async function syntheticProfile(
  version: string,
  sources: Readonly<Record<string, string>>,
): Promise<string> {
  const root = await temporary("synthetic-profile");
  const baselineRoot = path.join(root, "koni", "baseline");
  await mkdir(baselineRoot, { recursive: true });
  const files: ProfileBaselineFile[] = [];
  for (const [relative, source] of Object.entries(sources).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const bytes = Buffer.from(source, "utf8");
    await mkdir(path.dirname(path.join(baselineRoot, relative)), { recursive: true });
    await writeFile(path.join(baselineRoot, relative), bytes);
    files.push({
      path: relative,
      sha256: rawSha256(bytes),
      size_bytes: bytes.byteLength,
      kind: "config",
    });
  }
  const manifest: ProfilePackageManifest = {
    protocol: "koni.profile-package.v1",
    package: { name: "@koni/synthetic-profile", version },
    profile: { id: "synthetic", display_name: "Synthetic", version, lineage: "koni.synthetic" },
    compatibility: {
      core_api_range: ">=1.0.0 <2.0.0",
      profile_schema_range: ">=3.0.0 <4.0.0",
      pi_range: ">=0.80.10 <0.81.0",
    },
    baseline: { root: "./baseline", files },
    bundle_sha256: computeProfileBundleSha256(files),
  };
  await writeFile(
    path.join(root, "koni", "profile-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return root;
}
