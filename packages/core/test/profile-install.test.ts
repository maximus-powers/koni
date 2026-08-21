import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ProfileBaselineFile,
  ProfilePackageManifest,
} from "../src/contracts/profile-package.js";
import { computeProfileBundleSha256 } from "../src/compiler/profile-package.js";
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
