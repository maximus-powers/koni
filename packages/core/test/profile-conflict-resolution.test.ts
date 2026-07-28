import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import type { ProfilePackageManifest } from "../src/contracts/profile-package.js";
import { computeProfileBundleSha256 } from "../src/compiler/profile-package.js";
import {
  type ProjectConfigMutationError,
  resolveProfileUpstreamConflict,
} from "../src/profile/config-edit.js";
import { installProfile, readProfileLifecycle } from "../src/profile/install.js";
import { rawSha256 } from "../src/shared/canonical.js";

const roots: string[] = [];
const codingProfile = path.resolve(import.meta.dirname, "../../coding-profile");
const resourcePath = "resources/pi-packages.yaml";
const skillPath = "resources/skills/model-koni-work/references/graph-model.md";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}, 30_000);

describe("explicit profile upstream conflict resolution", () => {
  it("accepts only divergent YAML fields after upstream-only fields were auto-merged", async () => {
    const project = await temporary("field-merge-project");
    await installProfile(project, codingProfile);
    const profilePath = path.join(project, ".koni", "profile.yaml");
    const projectDocument = YAML.parse(await readFile(profilePath, "utf8")) as Record<string, any>;
    projectDocument.git.worktree_root = ".koni-worktrees/project";
    projectDocument.orchestration.max_parallel = 7;
    await writeFile(profilePath, `# project-specific tuning\n${YAML.stringify(projectDocument)}`);

    const upgraded = await fieldMergeCodingProfile();
    const result = await installProfile(project, upgraded);
    const pending = result.pendingUpstream.find((entry) => entry.path === "profile.yaml");
    expect(pending?.conflictPaths).toEqual(["/git/worktree_root"]);
    expect(result.pendingUpstream).toHaveLength(1);

    const mergedSource = await readFile(profilePath, "utf8");
    const merged = YAML.parse(mergedSource) as Record<string, any>;
    expect(mergedSource).toContain("# project-specific tuning");
    expect(merged.git.worktree_root).toBe(".koni-worktrees/project");
    expect(merged.orchestration.max_parallel).toBe(7);
    expect(merged.git.commit_template).toBe("upstream: {{ ticket.title }}");
    expect(merged.profile.version).toBe("99.0.0");

    const lifecycle = (await readProfileLifecycle(project))!;
    await resolveProfileUpstreamConflict({
      projectRoot: project,
      profilePackageRoot: upgraded,
      path: "profile.yaml",
      expectedLifecycleGeneration: lifecycle.generation,
      expectedProjectSha256: rawSha256(mergedSource),
      resolution: "accept_upstream",
    });

    const acceptedSource = await readFile(profilePath, "utf8");
    const accepted = YAML.parse(acceptedSource) as Record<string, any>;
    expect(acceptedSource).toContain("# project-specific tuning");
    expect(accepted.git.worktree_root).toBe(".koni-worktrees/upstream");
    expect(accepted.orchestration.max_parallel).toBe(7);
    expect(accepted.git.commit_template).toBe("upstream: {{ ticket.title }}");
    expect((await readProfileLifecycle(project))?.pendingUpstream).toEqual([]);
  }, 30_000);

  it("records keep-project and accept-upstream decisions under lifecycle/source CAS", async () => {
    const project = await temporary("project");
    await installProfile(project, codingProfile);
    const upgraded = await upgradedCodingProfile();
    const localResourceDocument = YAML.parse(
      await readFile(path.join(project, ".koni", resourcePath), "utf8"),
    ) as Record<string, any>;
    localResourceDocument.bindings[0].description = "Project resource choice.";
    const localResource = YAML.stringify(localResourceDocument);
    const localSkill = `${await readFile(path.join(project, ".koni", skillPath), "utf8")}\nProject-local guidance.\n`;
    await writeFile(path.join(project, ".koni", resourcePath), localResource);
    await writeFile(path.join(project, ".koni", skillPath), localSkill);

    const upgrade = await installProfile(project, upgraded);
    expect(upgrade.pendingUpstream.map(({ path: relative }) => relative)).toEqual([
      resourcePath,
      skillPath,
    ]);
    const firstLifecycle = (await readProfileLifecycle(project))!;
    const kept = await resolveProfileUpstreamConflict({
      projectRoot: project,
      profilePackageRoot: upgraded,
      path: resourcePath,
      expectedLifecycleGeneration: firstLifecycle.generation,
      expectedProjectSha256: rawSha256(localResource),
      resolution: "keep_project",
    });
    expect(kept.projectSha256).toBe(rawSha256(localResource));
    expect(await readFile(path.join(project, ".koni", resourcePath), "utf8")).toBe(localResource);
    const secondLifecycle = (await readProfileLifecycle(project))!;
    expect(secondLifecycle.pendingUpstream.map(({ path: relative }) => relative)).toEqual([
      skillPath,
    ]);

    await expect(
      resolveProfileUpstreamConflict({
        projectRoot: project,
        profilePackageRoot: upgraded,
        path: skillPath,
        expectedLifecycleGeneration: firstLifecycle.generation,
        expectedProjectSha256: rawSha256(localSkill),
        resolution: "accept_upstream",
      }),
    ).rejects.toMatchObject({
      code: "lifecycle_changed",
    } satisfies Partial<ProjectConfigMutationError>);

    const accepted = await resolveProfileUpstreamConflict({
      projectRoot: project,
      profilePackageRoot: upgraded,
      path: skillPath,
      expectedLifecycleGeneration: secondLifecycle.generation,
      expectedProjectSha256: rawSha256(localSkill),
      resolution: "accept_upstream",
    });
    const upstreamSkill = await readFile(
      path.join(upgraded, "koni", "baseline", skillPath),
      "utf8",
    );
    expect(await readFile(path.join(project, ".koni", skillPath), "utf8")).toBe(upstreamSkill);
    const finalLifecycle = (await readProfileLifecycle(project))!;
    expect(finalLifecycle.pendingUpstream).toEqual([]);
    expect(
      finalLifecycle.upstreamResolutions.map(({ path: relative, resolution }) => [
        relative,
        resolution,
      ]),
    ).toEqual([
      [resourcePath, "keep_project"],
      [skillPath, "accept_upstream"],
    ]);
    expect(finalLifecycle.generation).toBe(accepted.lifecycleGeneration);

    const lifecyclePath = path.join(project, ".koni", ".managed", "lifecycle.json");
    const partialWitness = JSON.parse(await readFile(lifecyclePath, "utf8")) as {
      upstreamResolutions: Array<Record<string, unknown>>;
    };
    delete partialWitness.upstreamResolutions.at(-1)!.effectiveBundleSha256;
    await writeFile(lifecyclePath, `${JSON.stringify(partialWitness, null, 2)}\n`);
    await expect(readProfileLifecycle(project)).rejects.toMatchObject({
      code: "lifecycle_invalid",
    });
  }, 30_000);
});

async function upgradedCodingProfile(): Promise<string> {
  const root = await temporary("upgraded-profile");
  await cp(codingProfile, root, { recursive: true });
  const baselineRoot = path.join(root, "koni", "baseline");
  const profilePath = path.join(baselineRoot, "profile.yaml");
  await writeFile(
    profilePath,
    (await readFile(profilePath, "utf8")).replace("version: 0.7.0", "version: 0.8.0"),
  );
  const resource = YAML.parse(
    await readFile(path.join(baselineRoot, resourcePath), "utf8"),
  ) as Record<string, any>;
  resource.bindings[0].description = "Upstream resource revision.";
  await writeFile(path.join(baselineRoot, resourcePath), YAML.stringify(resource));
  await writeFile(
    path.join(baselineRoot, skillPath),
    `${await readFile(path.join(baselineRoot, skillPath), "utf8")}\nUpstream guidance revision.\n`,
  );
  const manifestPath = path.join(root, "koni", "profile-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProfilePackageManifest;
  const files = await Promise.all(
    manifest.baseline.files.map(async (descriptor) => {
      const bytes = await readFile(path.join(baselineRoot, descriptor.path));
      return { ...descriptor, sha256: rawSha256(bytes), size_bytes: bytes.byteLength };
    }),
  );
  const upgraded: ProfilePackageManifest = {
    ...manifest,
    package: { ...manifest.package, version: "0.8.0" },
    profile: { ...manifest.profile, version: "0.8.0" },
    baseline: { ...manifest.baseline, files },
    bundle_sha256: computeProfileBundleSha256(files, manifest.migrations ?? []),
  };
  await writeFile(manifestPath, `${JSON.stringify(upgraded, null, 2)}\n`);
  return root;
}

async function fieldMergeCodingProfile(): Promise<string> {
  const root = await temporary("field-merge-profile");
  await cp(codingProfile, root, { recursive: true });
  const baselineRoot = path.join(root, "koni", "baseline");
  const profilePath = path.join(baselineRoot, "profile.yaml");
  const profile = YAML.parse(await readFile(profilePath, "utf8")) as Record<string, any>;
  profile.profile.version = "99.0.0";
  profile.git.worktree_root = ".koni-worktrees/upstream";
  profile.git.commit_template = "upstream: {{ ticket.title }}";
  await writeFile(profilePath, YAML.stringify(profile));

  const manifestPath = path.join(root, "koni", "profile-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProfilePackageManifest;
  const files = await Promise.all(
    manifest.baseline.files.map(async (descriptor) => {
      const bytes = await readFile(path.join(baselineRoot, descriptor.path));
      return { ...descriptor, sha256: rawSha256(bytes), size_bytes: bytes.byteLength };
    }),
  );
  const upgraded: ProfilePackageManifest = {
    ...manifest,
    package: { ...manifest.package, version: "99.0.0" },
    profile: { ...manifest.profile, version: "99.0.0" },
    baseline: { ...manifest.baseline, files },
    bundle_sha256: computeProfileBundleSha256(files, manifest.migrations ?? []),
  };
  await writeFile(manifestPath, `${JSON.stringify(upgraded, null, 2)}\n`);
  return root;
}

async function temporary(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `koni-${label}-`));
  roots.push(root);
  return root;
}
