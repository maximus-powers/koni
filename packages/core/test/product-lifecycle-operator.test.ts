import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { ProfilePackageManifest } from "../src/contracts/profile-package.js";
import { computeProfileBundleSha256 } from "../src/compiler/profile-package.js";
import {
  installAndCacheProfile,
  inspectProjectProfileInstallState,
} from "../src/operator/profile-source.js";
import {
  inspectProjectProfileConflict,
  listProjectProfileConflicts,
  recoverProjectProfileConflictResolution,
  resolveProjectProfileConflict,
} from "../src/operator/profile-lifecycle.js";
import { installProfile, readProfileLifecycle } from "../src/profile/install.js";
import { canonicalHash, rawSha256 } from "../src/shared/canonical.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const codingProfile = path.resolve(import.meta.dirname, "../../coding-profile");
const resourcePath = "agents/lead.yaml";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("guarded project profile entry", () => {
  it("allows managed upgrades, ignores unrelated Codex data, and blocks unmanaged .koni roots", async () => {
    const managed = await project("managed");
    await installAndCacheProfile({ projectRoot: managed, profilePackageRoot: codingProfile });
    await expect(
      installAndCacheProfile({ projectRoot: managed, profilePackageRoot: codingProfile }),
    ).resolves.toMatchObject({ packageName: "@koni/coding-profile" });
    expect(await inspectProjectProfileInstallState(managed)).toBe("managed");

    const codex = await project("codex");
    await mkdir(path.join(codex, ".codex", "koni"), { recursive: true });
    await expect(
      installAndCacheProfile({ projectRoot: codex, profilePackageRoot: codingProfile }),
    ).resolves.toMatchObject({ packageName: "@koni/coding-profile" });
    expect(await inspectProjectProfileInstallState(codex)).toBe("managed");

    const unmanaged = await project("unmanaged");
    await mkdir(path.join(unmanaged, ".koni"));
    await expect(
      installAndCacheProfile({ projectRoot: unmanaged, profilePackageRoot: codingProfile }),
    ).rejects.toMatchObject({ code: "profile_not_managed" });
  }, 30_000);

  it("fails closed for redirected configuration and managed-marker ancestors", async () => {
    const redirectedManaged = await project("redirected-managed");
    const outsideManaged = await temporary("outside-managed");
    await mkdir(path.join(redirectedManaged, ".koni"));
    await mkdir(outsideManaged, { recursive: true });
    await writeFile(path.join(outsideManaged, "install.json"), "{}\n");
    await symlink(outsideManaged, path.join(redirectedManaged, ".koni", ".managed"));
    await expect(
      installAndCacheProfile({ projectRoot: redirectedManaged, profilePackageRoot: codingProfile }),
    ).rejects.toMatchObject({ code: "profile_not_managed" });
  }, 30_000);
});

describe("upstream profile conflict service", () => {
  it("lists, inspects, and resolves authenticated document pairs under lifecycle/source CAS", async () => {
    const root = await project("conflicts");
    await installProfile(root, codingProfile);
    const upgraded = await upgradedCodingProfile();
    const local = rewriteAgentDescription(
      await readFile(path.join(root, ".koni", resourcePath), "utf8"),
      "project choice",
    );
    await writeFile(path.join(root, ".koni", resourcePath), local);
    await installProfile(root, upgraded);

    const catalog = await listProjectProfileConflicts(root, upgraded);
    expect(catalog.conflicts).toEqual([
      expect.objectContaining({ path: resourcePath, title: "Lead", reason: "modified" }),
    ]);
    const inspected = await inspectProjectProfileConflict(root, upgraded, resourcePath);
    expect(inspected.currentText).toBe(local);
    expect(inspected.upstreamText).toContain("upstream revision");
    await resolveProjectProfileConflict({
      projectRoot: root,
      profilePackageRoot: upgraded,
      path: resourcePath,
      expectedLifecycleGeneration: inspected.lifecycleGeneration,
      expectedProjectSha256: inspected.conflict.currentSha256,
      resolution: "accept_upstream",
    });
    expect((await listProjectProfileConflicts(root, upgraded)).conflicts).toEqual([]);
  }, 30_000);

  it("reconstructs only the exact crash-gap resolution and rejects every ambiguous replay", async () => {
    const root = await project("conflict-crash-recovery");
    await installProfile(root, codingProfile);
    const upgraded = await upgradedCodingProfile();
    const local = rewriteAgentDescription(
      await readFile(path.join(root, ".koni", resourcePath), "utf8"),
      "keepable project choice",
    );
    await writeFile(path.join(root, ".koni", resourcePath), local);
    await installProfile(root, upgraded);
    const inspected = await inspectProjectProfileConflict(root, upgraded, resourcePath);
    const semantic = {
      path: resourcePath,
      expectedLifecycleGeneration: inspected.lifecycleGeneration,
      expectedProjectSha256: inspected.conflict.currentSha256,
      resolution: "accept_upstream" as const,
    };
    const requestSha256 = conflictRequestSha256(semantic);

    // Simulate process death after the profile transaction committed but before the authority
    // store could publish its revisioned receipt.
    const committed = await resolveProjectProfileConflict({
      projectRoot: root,
      profilePackageRoot: upgraded,
      ...semantic,
      authorityRequestSha256: requestSha256,
    });
    const recovered = await recoverProjectProfileConflictResolution({
      projectRoot: root,
      profilePackageRoot: upgraded,
      ...semantic,
      authorityRequestSha256: requestSha256,
    });
    expect(recovered).toMatchObject({
      recovered: true,
      path: resourcePath,
      resolution: "accept_upstream",
      lifecycleGeneration: committed.lifecycleGeneration,
      configurationSha256: committed.configurationSha256,
      effectiveBundleSha256: committed.effectiveBundleSha256,
      authorityRequestSha256: requestSha256,
    });

    const wrongDecision = { ...semantic, resolution: "keep_project" as const };
    await expect(
      recoverProjectProfileConflictResolution({
        projectRoot: root,
        profilePackageRoot: upgraded,
        ...wrongDecision,
        authorityRequestSha256: conflictRequestSha256(wrongDecision),
      }),
    ).rejects.toMatchObject({ code: "profile_conflict_recovery_ambiguous" });

    const wrongPath = { ...semantic, path: "project.yaml" };
    await expect(
      recoverProjectProfileConflictResolution({
        projectRoot: root,
        profilePackageRoot: upgraded,
        ...wrongPath,
        authorityRequestSha256: conflictRequestSha256(wrongPath),
      }),
    ).rejects.toMatchObject({ code: "profile_conflict_recovery_ambiguous" });

    const wrongSource = { ...semantic, expectedProjectSha256: rawSha256("other project source") };
    await expect(
      recoverProjectProfileConflictResolution({
        projectRoot: root,
        profilePackageRoot: upgraded,
        ...wrongSource,
        authorityRequestSha256: conflictRequestSha256(wrongSource),
      }),
    ).rejects.toMatchObject({ code: "profile_conflict_recovery_ambiguous" });

    const wrongGeneration = {
      ...semantic,
      expectedLifecycleGeneration: semantic.expectedLifecycleGeneration - 1,
    };
    await expect(
      recoverProjectProfileConflictResolution({
        projectRoot: root,
        profilePackageRoot: upgraded,
        ...wrongGeneration,
        authorityRequestSha256: conflictRequestSha256(wrongGeneration),
      }),
    ).rejects.toMatchObject({ code: "profile_conflict_recovery_ambiguous" });

    await expect(
      recoverProjectProfileConflictResolution({
        projectRoot: root,
        profilePackageRoot: upgraded,
        ...semantic,
        authorityRequestSha256: rawSha256("wrong authority request"),
      }),
    ).rejects.toMatchObject({ code: "profile_conflict_recovery_request" });

    const beforeConcurrent = (await readProfileLifecycle(root))!.generation;
    await installProfile(root, upgraded);
    expect((await readProfileLifecycle(root))!.generation).toBe(beforeConcurrent + 1);
    await expect(
      recoverProjectProfileConflictResolution({
        projectRoot: root,
        profilePackageRoot: upgraded,
        ...semantic,
        authorityRequestSha256: requestSha256,
      }),
    ).rejects.toMatchObject({ code: "profile_conflict_recovery_ambiguous" });
  }, 30_000);

  it("never follows a swapped project ancestor while inspecting a conflict", async () => {
    const root = await project("conflict-symlink");
    await installProfile(root, codingProfile);
    const upgraded = await upgradedCodingProfile();
    const local = rewriteAgentDescription(
      await readFile(path.join(root, ".koni", resourcePath), "utf8"),
      "Project choice.",
    );
    await writeFile(path.join(root, ".koni", resourcePath), local);
    await installProfile(root, upgraded);
    const agentsRoot = path.join(root, ".koni", "agents");
    const retained = path.join(root, ".koni", "agents-retained");
    const outside = await temporary("outside-agents");
    await rename(agentsRoot, retained);
    await symlink(outside, agentsRoot);
    await expect(inspectProjectProfileConflict(root, upgraded, resourcePath)).rejects.toMatchObject(
      {
        code: "profile_conflict_path",
      },
    );
  }, 30_000);
});

async function project(label: string): Promise<string> {
  const root = await temporary(label);
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  return root;
}

async function temporary(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `koni-product-${label}-`));
  const canonical = await realpath(root);
  roots.push(canonical);
  return canonical;
}

function conflictRequestSha256(input: {
  path: string;
  expectedLifecycleGeneration: number;
  expectedProjectSha256: `sha256:${string}` | null;
  resolution: "keep_project" | "accept_upstream";
}): `sha256:${string}` {
  return canonicalHash({ method: "profile.conflicts.resolve", params: input });
}

async function upgradedCodingProfile(): Promise<string> {
  const root = await temporary("upgraded-profile");
  await cp(codingProfile, root, { recursive: true });
  await rewritePackageFile(root, resourcePath, (source) =>
    rewriteAgentDescription(source, "upstream revision"),
  );
  return root;
}

function rewriteAgentDescription(source: string, description: string): string {
  const document = YAML.parse(source) as Record<string, unknown>;
  if (typeof document.id !== "string") throw new Error("agent fixture lacks an identity");
  document.description = description;
  return YAML.stringify(document);
}

async function rewritePackageFile(
  packageRoot: string,
  relativePath: string,
  rewrite: (source: string) => string,
): Promise<void> {
  const baselineRoot = path.join(packageRoot, "koni", "baseline");
  await writeFile(
    path.join(baselineRoot, relativePath),
    rewrite(await readFile(path.join(baselineRoot, relativePath), "utf8")),
  );
  const manifestPath = path.join(packageRoot, "koni", "profile-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProfilePackageManifest;
  const version = nextPatchVersion(manifest.package.version);
  const profilePath = path.join(baselineRoot, "profile.yaml");
  const profileSource = await readFile(profilePath, "utf8");
  await writeFile(
    profilePath,
    profileSource.replace(/^ {2}version: [^\n]+/mu, `  version: ${version}`),
  );
  const files = await Promise.all(
    manifest.baseline.files.map(async (descriptor) => {
      const bytes = await readFile(path.join(baselineRoot, descriptor.path));
      return { ...descriptor, sha256: rawSha256(bytes), size_bytes: bytes.byteLength };
    }),
  );
  const next: ProfilePackageManifest = {
    ...manifest,
    package: { ...manifest.package, version },
    profile: { ...manifest.profile, version },
    baseline: { ...manifest.baseline, files },
    bundle_sha256: computeProfileBundleSha256(files, manifest.migrations ?? []),
  };
  await writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
}

function nextPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) throw new Error(`profile fixture version is not stable semver: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}
