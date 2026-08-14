import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  loadProfilePackage,
  previewProfileInstall,
  readProfileLifecycle,
  type ProfileInstallError,
} from "../src/profile/install.js";
import { rawSha256 } from "../src/shared/canonical.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];

const releases = [
  {
    name: "Coding",
    directory: "coding-profile",
    fixtureDirectory: "coding-0.7.0",
    oldVersion: "0.7.0",
    newVersion: "0.8.27",
    oldBundleSha256: "sha256:4e955f7fb5a6bbd58542f395471d2e3f1c87364840abd218f973b8f62a5c0c7e",
    newBundleSha256: "sha256:38f5c7cab58be61bf8f2cb5544974e7745ebb2cd779360a24f7dcef09ac7b9bc",
    parallelism: { source: 5, project: 7 },
  },
  {
    name: "Research",
    directory: "research-profile",
    fixtureDirectory: "research-1.0.11",
    oldVersion: "1.0.11",
    newVersion: "1.1.39",
    oldBundleSha256: "sha256:1bc8bdb64934ccd475f50acad5b22a7b1b6f7e168a748ecd91e234be76126c60",
    newBundleSha256: "sha256:332284aa8e4357671f82028dbc346a37039aa6410b37762ba588e46829d036da",
    parallelism: { source: 64, project: 17 },
  },
] as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}, 30_000);

describe("official profile release upgrades", () => {
  it.each(releases)(
    "$name upgrades its exact prior bundle, preserves overlays, and rejects replay",
    async (release) => {
      const targetPackage = path.join(repositoryRoot, "packages", release.directory);
      const oldPackage = await buildPriorReleasePackage(release);
      const project = await temporary(`${release.directory}-upgrade`);
      const initial = await installProfile(project, oldPackage);
      expect(initial.bundleSha256).toBe(release.oldBundleSha256);
      const oldInstall = await readFile(path.join(project, ".koni", ".managed", "install.json"));

      const profilePath = path.join(project, ".koni", "profile.yaml");
      const oldProfile = await readFile(profilePath, "utf8");
      await writeFile(
        profilePath,
        replaceRequired(
          replaceRequired(
            oldProfile,
            `  max_parallel: ${release.parallelism.source}\n`,
            `  max_parallel: ${release.parallelism.project}\n`,
          ),
          "  max_fixpoint_passes: 8\n",
          "  max_fixpoint_passes: 13\n",
        ),
      );
      const projectResourcePath = path.join(
        project,
        ".koni",
        "resources",
        "skills",
        "configure-koni",
        "references",
        "configuration-layers.md",
      );
      await writeFile(
        projectResourcePath,
        `${await readFile(projectResourcePath, "utf8")}\nProject-owned configuration guidance.\n`,
      );

      const preview = await previewProfileInstall(project, targetPackage);
      expect(preview.bundleSha256).toBe(release.newBundleSha256);
      expect(preview.mandatoryRetirements).toHaveLength(1);
      expect(preview.mandatoryRetirements[0]).toMatchObject({
        id: "retire-inert-semantics-v1",
        sourceBundleSha256: release.oldBundleSha256,
        targetBundleSha256: release.newBundleSha256,
      });
      await expect(installProfile(project, targetPackage)).rejects.toMatchObject({
        code: "retirement_preview_required",
      } satisfies Partial<ProfileInstallError>);

      const upgraded = await installProfile(project, targetPackage, {
        expectedPreviewSha256: preview.previewSha256,
      });
      expect(upgraded.profileVersion).toBe(release.newVersion);
      expect(upgraded.pendingUpstream).toContainEqual(
        expect.objectContaining({
          path: "resources/skills/configure-koni/references/configuration-layers.md",
          reason: "orphaned",
        }),
      );
      const appliedProfile = await readFile(profilePath, "utf8");
      expect(appliedProfile).toContain(`  version: ${release.newVersion}`);
      expect(appliedProfile).toContain(`  max_parallel: ${release.parallelism.project}`);
      expect(appliedProfile).not.toContain("max_fixpoint_passes");
      expect(appliedProfile).not.toContain("lease_stale_seconds");
      expect(appliedProfile).not.toContain("storage:");
      expect(await readFile(projectResourcePath, "utf8")).toContain(
        "Project-owned configuration guidance",
      );
      expect(await readFile(path.join(project, ".koni", "agents", "lead.yaml"), "utf8")).toContain(
        "koni.lead-judgment-output.v1",
      );

      const lifecycle = (await readProfileLifecycle(project))!;
      expect(lifecycle.semanticRetirements).toHaveLength(1);
      const retirement = lifecycle.semanticRetirements[0]!;
      expect(retirement).toMatchObject({
        id: "retire-inert-semantics-v1",
        sourceBundleSha256: release.oldBundleSha256,
        targetBundleSha256: release.newBundleSha256,
      });
      expect(
        await readFile(
          path.join(project, ".koni", retirement.artifactRoot, "receipt.json"),
          "utf8",
        ),
      ).toContain(preview.previewSha256);

      const repeated = await installProfile(project, targetPackage);
      expect(repeated.mandatoryRetirements).toEqual([]);
      expect((await readProfileLifecycle(project))?.semanticRetirements).toHaveLength(1);

      // Re-presenting old install authority while retaining the applied receipt is a replay,
      // not a second opportunity to erase project bytes.
      const replayLifecyclePath = path.join(project, ".koni", ".managed", "lifecycle.json");
      const replayLifecycle = JSON.parse(await readFile(replayLifecyclePath, "utf8"));
      replayLifecycle.installedBundleSha256 = release.oldBundleSha256;
      replayLifecycle.installedProfileVersion = release.oldVersion;
      await writeFile(path.join(project, ".koni", ".managed", "install.json"), oldInstall);
      await writeFile(replayLifecyclePath, `${JSON.stringify(replayLifecycle, null, 2)}\n`);
      await expect(previewProfileInstall(project, targetPackage)).rejects.toMatchObject({
        code: "retirement_replay",
      } satisfies Partial<ProfileInstallError>);
    },
    60_000,
  );

  it.each(releases)(
    "$name rejects a same-version bundle not named by the release",
    async (release) => {
      const targetPackage = path.join(repositoryRoot, "packages", release.directory);
      const wrongSource = await buildPriorReleasePackage(release);
      const projectFile = path.join(wrongSource, "koni", "baseline", "project.yaml");
      await writeFile(
        projectFile,
        `${await readFile(projectFile, "utf8")}# unauthorized rebuild\n`,
      );
      const wrongManifest = await refreshManifest(wrongSource);
      expect(wrongManifest.bundle_sha256).not.toBe(release.oldBundleSha256);
      const project = await temporary(`${release.directory}-wrong-source`);
      await installProfile(project, wrongSource);
      await expect(previewProfileInstall(project, targetPackage)).rejects.toMatchObject({
        code: "retirement_source_bundle",
      } satisfies Partial<ProfileInstallError>);
    },
    60_000,
  );

  it.each(releases)(
    "$name rejects an older bundle outside the named release range",
    async (release) => {
      const targetPackage = path.join(repositoryRoot, "packages", release.directory);
      const wrongSource = await buildPriorReleasePackage(release);
      const projectFile = path.join(wrongSource, "koni", "baseline", "project.yaml");
      await writeFile(projectFile, `${await readFile(projectFile, "utf8")}# older rebuild\n`);
      const manifestPath = path.join(wrongSource, "koni", "profile-manifest.json");
      const wrongManifest = await refreshManifest(wrongSource);
      wrongManifest.profile.version = "0.1.0";
      wrongManifest.package.version = "0.1.0";
      await writeFile(manifestPath, `${JSON.stringify(wrongManifest, null, 2)}\n`);
      const project = await temporary(`${release.directory}-older-unknown-source`);
      await installProfile(project, wrongSource);
      await expect(previewProfileInstall(project, targetPackage)).rejects.toMatchObject({
        code: "retirement_source_bundle",
      } satisfies Partial<ProfileInstallError>);
    },
    60_000,
  );

  it.each(releases)(
    "$name preserves comment-only customization in a retirement-touched YAML file",
    async (release) => {
      const targetPackage = path.join(repositoryRoot, "packages", release.directory);
      const oldPackage = await buildPriorReleasePackage(release);
      const project = await temporary(`${release.directory}-comment-overlay`);
      await installProfile(project, oldPackage);
      const profilePath = path.join(project, ".koni", "profile.yaml");
      await writeFile(
        profilePath,
        `# project-owned profile note\n${await readFile(profilePath, "utf8")}`,
      );

      const preview = await previewProfileInstall(project, targetPackage);
      await installProfile(project, targetPackage, {
        expectedPreviewSha256: preview.previewSha256,
      });
      const profile = await readFile(profilePath, "utf8");
      expect(profile).toContain("# project-owned profile note");
      expect(profile).toContain(`  version: ${release.newVersion}`);
      expect(profile).not.toContain("max_fixpoint_passes");
      expect(profile).not.toContain("storage:");
    },
    60_000,
  );

  it.each(releases)(
    "$name rejects a changed immutable source archive",
    async (release) => {
      const targetPackage = path.join(repositoryRoot, "packages", release.directory);
      const oldPackage = await buildPriorReleasePackage(release);
      const project = await temporary(`${release.directory}-source-archive-tamper`);
      await installProfile(project, oldPackage);
      const lifecycle = (await readProfileLifecycle(project))!;
      const source = lifecycle.immutableBaselines.find(
        (entry) => entry.bundleSha256 === release.oldBundleSha256,
      )!;
      const archivedProfile = path.join(project, ".koni", source.root, "files", "profile.yaml");
      await writeFile(
        archivedProfile,
        `${await readFile(archivedProfile, "utf8")}# changed archive\n`,
      );
      await expect(previewProfileInstall(project, targetPackage)).rejects.toMatchObject({
        code: "baseline_store_corrupt",
      } satisfies Partial<ProfileInstallError>);
    },
    60_000,
  );

  it.each(releases)(
    "$name rejects descriptor and resource tampering",
    async (release) => {
      const targetPackage = path.join(repositoryRoot, "packages", release.directory);

      const descriptorTamper = await temporary(`${release.directory}-descriptor-tamper`);
      await cp(targetPackage, descriptorTamper, { recursive: true });
      const manifestPath = path.join(descriptorTamper, "koni", "profile-manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.migrations[0].from_profile_range = "*";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await expect(loadProfilePackage(descriptorTamper)).rejects.toMatchObject({
        code: "manifest_invalid",
      } satisfies Partial<ProfileInstallError>);

      const resourceTamper = await temporary(`${release.directory}-resource-tamper`);
      await cp(targetPackage, resourceTamper, { recursive: true });
      const resourcePath = path.join(
        resourceTamper,
        "koni",
        "migrations",
        "retire-inert-semantics-v1.json",
      );
      await writeFile(resourcePath, `${await readFile(resourcePath, "utf8")} `);
      await expect(loadProfilePackage(resourceTamper)).rejects.toMatchObject({
        code: "migration_resource_sha256",
      } satisfies Partial<ProfileInstallError>);
    },
    30_000,
  );
});

async function buildPriorReleasePackage(release: (typeof releases)[number]): Promise<string> {
  const root = await temporary(`${release.directory}-prior-release`);
  const fixture = path.join(
    import.meta.dirname,
    "fixtures",
    "profile-prior-releases",
    release.fixtureDirectory,
  );
  await cp(fixture, root, { recursive: true });
  // The fixture models an already-installed prior release. Widen only this temporary package's
  // loader envelope so current Core can reconstruct that historical install before exercising the
  // target release's exact bundle-bound migration. The frozen baseline bytes and bundle identity
  // remain unchanged.
  const manifestPath = path.join(root, "koni", "profile-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProfilePackageManifest;
  manifest.compatibility.profile_schema_range = ">=2.0.0 <4.0.0";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const loaded = await loadProfilePackage(root);
  expect(loaded.manifest.bundle_sha256).toBe(release.oldBundleSha256);
  return root;
}

async function refreshManifest(packageRoot: string): Promise<ProfilePackageManifest> {
  const manifestPath = path.join(packageRoot, "koni", "profile-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProfilePackageManifest;
  const baselineRoot = path.join(packageRoot, "koni", "baseline");
  const files: ProfileBaselineFile[] = [];
  for (const descriptor of manifest.baseline.files) {
    const bytes = await readFile(path.join(baselineRoot, descriptor.path));
    files.push({
      path: descriptor.path,
      sha256: rawSha256(bytes),
      size_bytes: bytes.byteLength,
      kind: descriptor.kind,
    });
  }
  manifest.baseline.files = files;
  manifest.bundle_sha256 = computeProfileBundleSha256(files, manifest.migrations ?? []);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function replaceRequired(source: string, search: string, replacement: string): string {
  if (!source.includes(search)) {
    throw new Error(`release fixture source is missing ${JSON.stringify(search)}`);
  }
  return source.replace(search, replacement);
}

async function temporary(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `koni-${label}-`));
  roots.push(root);
  return root;
}
