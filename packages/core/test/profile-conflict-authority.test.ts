import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { AuthorityClient } from "../src/authority/client.js";
import { RunAuthorityEngine, type RunCompilerProgram } from "../src/authority/run-engine.js";
import { computeProfileBundleSha256 } from "../src/compiler/profile-package.js";
import type { ProfilePackageManifest } from "../src/contracts/profile-package.js";
import { resolveProjectProfileConflict } from "../src/operator/profile-lifecycle.js";
import { ManagedSessionSupervisor } from "../src/pi/supervisor.js";
import { installProfile } from "../src/profile/install.js";
import { canonicalHash, rawSha256 } from "../src/shared/canonical.js";

const execFileAsync = promisify(execFile);
const codingProfile = path.resolve(import.meta.dirname, "../../coding-profile");
const resourcePath = "resources/pi-packages.yaml";
const unrelatedResourcePath = "resources/skills/model-koni-work/references/graph-model.md";
const roots: string[] = [];
const engines: RunAuthorityEngine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("profile conflict authority", () => {
  it("seals roots, exposes authenticated documents, resolves once, and replays its receipt", async () => {
    const fixture = await conflictFixture("authority-normal");
    const { engine, client } = await authority(fixture.projectRoot, fixture.upgradedProfile);

    const catalog = (await client.request("profile.conflicts.list")).result as {
      lifecycleGeneration: number;
      conflicts: Array<{ path: string; currentSha256: `sha256:${string}` | null }>;
    };
    expect(catalog.conflicts).toEqual([
      expect.objectContaining({ path: resourcePath, currentSha256: fixture.projectSha256 }),
    ]);
    const inspection = (await client.request("profile.conflicts.inspect", { path: resourcePath }))
      .result as {
      currentText: string;
      upstreamText: string;
    };
    expect(inspection.currentText).toContain("project choice");
    expect(inspection.upstreamText).toContain("upstream revision");

    await expect(
      client.request("profile.conflicts.inspect", {
        path: resourcePath,
        projectRoot: "/ambient/project",
      }),
    ).rejects.toMatchObject({ code: "params" });

    const params = {
      path: resourcePath,
      expectedLifecycleGeneration: catalog.lifecycleGeneration,
      expectedProjectSha256: fixture.projectSha256,
      resolution: "accept_upstream",
    } as const;
    const first = await client.request("profile.conflicts.resolve", params, {
      expectedRevision: client.revision,
      idempotencyKey: "resolve-profile-conflict-once",
    });
    expect(first.result).toMatchObject({
      protocol: "koni.profile-conflict-resolution-result.v1",
      path: resourcePath,
      resolution: "accept_upstream",
      recovered: false,
      requestSha256: canonicalHash({ method: "profile.conflicts.resolve", params }),
    });
    const afterFirst = await engine.store.state();
    const replay = await client.request("profile.conflicts.resolve", params, {
      expectedRevision: 0,
      idempotencyKey: "resolve-profile-conflict-once",
    });
    expect(replay.result).toEqual(first.result);
    expect((await engine.store.state()).revision).toBe(afterFirst.revision);
    expect(
      ((await client.request("profile.conflicts.list")).result as { conflicts: unknown[] })
        .conflicts,
    ).toEqual([]);
    client.close();
  }, 30_000);

  it("recovers only an exact committed profile transaction whose authority receipt was lost", async () => {
    const fixture = await conflictFixture("authority-crash-gap");
    const { engine, client } = await authority(fixture.projectRoot, fixture.upgradedProfile);
    const catalog = (await client.request("profile.conflicts.list")).result as {
      lifecycleGeneration: number;
      conflicts: Array<{ currentSha256: `sha256:${string}` | null }>;
    };
    const params = {
      path: resourcePath,
      expectedLifecycleGeneration: catalog.lifecycleGeneration,
      expectedProjectSha256: catalog.conflicts[0]!.currentSha256,
      resolution: "keep_project",
    } as const;
    const authorityRequestSha256 = canonicalHash({ method: "profile.conflicts.resolve", params });

    // This is the exact crash gap: the profile transaction is durable, but the authority store has
    // not yet committed its revisioned RPC receipt.
    const transaction = await resolveProjectProfileConflict({
      projectRoot: fixture.projectRoot,
      profilePackageRoot: fixture.upgradedProfile,
      ...params,
      authorityRequestSha256,
    });
    const before = await engine.store.state();
    const recovered = await client.request("profile.conflicts.resolve", params, {
      expectedRevision: client.revision,
      idempotencyKey: "recover-exact-profile-conflict",
    });
    expect(recovered.result).toMatchObject({
      protocol: "koni.profile-conflict-resolution-result.v1",
      path: resourcePath,
      resolution: "keep_project",
      recovered: true,
      requestSha256: authorityRequestSha256,
      configurationSha256: transaction.configurationSha256,
      effectiveBundleSha256: transaction.effectiveBundleSha256,
    });
    expect((await engine.store.state()).revision).toBe(before.revision + 1);

    const replay = await client.request("profile.conflicts.resolve", params, {
      expectedRevision: 0,
      idempotencyKey: "recover-exact-profile-conflict",
    });
    expect(replay.result).toEqual(recovered.result);
    client.close();
  }, 30_000);

  it("rejects crash-gap recovery after another valid authored resource drifts", async () => {
    const fixture = await conflictFixture("authority-crash-gap-drift");
    const { engine, client } = await authority(fixture.projectRoot, fixture.upgradedProfile);
    const catalog = (await client.request("profile.conflicts.list")).result as {
      lifecycleGeneration: number;
      conflicts: Array<{ currentSha256: `sha256:${string}` | null }>;
    };
    const params = {
      path: resourcePath,
      expectedLifecycleGeneration: catalog.lifecycleGeneration,
      expectedProjectSha256: catalog.conflicts[0]!.currentSha256,
      resolution: "keep_project",
    } as const;
    const authorityRequestSha256 = canonicalHash({ method: "profile.conflicts.resolve", params });

    await resolveProjectProfileConflict({
      projectRoot: fixture.projectRoot,
      profilePackageRoot: fixture.upgradedProfile,
      ...params,
      authorityRequestSha256,
    });
    const unrelated = path.join(fixture.projectRoot, ".koni", unrelatedResourcePath);
    await writeFile(
      unrelated,
      `${await readFile(unrelated, "utf8")}\nProject guidance added after the transaction.\n`,
    );
    const before = await engine.store.state();

    await expect(
      client.request("profile.conflicts.resolve", params, {
        expectedRevision: client.revision,
        idempotencyKey: "reject-drifted-profile-conflict-recovery",
      }),
    ).rejects.toMatchObject({ code: "profile_conflict_recovery_ambiguous" });
    expect((await engine.store.state()).revision).toBe(before.revision);
    client.close();
  }, 30_000);

  it("keeps historical resolution metadata readable without inventing a recoverable receipt", async () => {
    const fixture = await conflictFixture("authority-crash-gap-legacy-witness");
    const { engine, client } = await authority(fixture.projectRoot, fixture.upgradedProfile);
    const catalog = (await client.request("profile.conflicts.list")).result as {
      lifecycleGeneration: number;
      conflicts: Array<{ currentSha256: `sha256:${string}` | null }>;
    };
    const params = {
      path: resourcePath,
      expectedLifecycleGeneration: catalog.lifecycleGeneration,
      expectedProjectSha256: catalog.conflicts[0]!.currentSha256,
      resolution: "keep_project",
    } as const;
    const authorityRequestSha256 = canonicalHash({ method: "profile.conflicts.resolve", params });
    await resolveProjectProfileConflict({
      projectRoot: fixture.projectRoot,
      profilePackageRoot: fixture.upgradedProfile,
      ...params,
      authorityRequestSha256,
    });

    const lifecyclePath = path.join(fixture.projectRoot, ".koni", ".managed", "lifecycle.json");
    const lifecycle = JSON.parse(await readFile(lifecyclePath, "utf8")) as {
      upstreamResolutions: Array<Record<string, unknown>>;
    };
    const historical = lifecycle.upstreamResolutions.at(-1)!;
    delete historical.configurationSha256;
    delete historical.effectiveBundleSha256;
    await writeFile(lifecyclePath, `${JSON.stringify(lifecycle, null, 2)}\n`);
    const before = await engine.store.state();

    await expect(
      client.request("profile.conflicts.resolve", params, {
        expectedRevision: client.revision,
        idempotencyKey: "reject-unbound-historical-profile-conflict-recovery",
      }),
    ).rejects.toMatchObject({ code: "profile_conflict_recovery_ambiguous" });
    expect((await engine.store.state()).revision).toBe(before.revision);
    client.close();
  }, 30_000);
});

async function conflictFixture(label: string): Promise<{
  projectRoot: string;
  upgradedProfile: string;
  projectSha256: `sha256:${string}`;
}> {
  const projectRoot = await temporary(`${label}-project`);
  await execFileAsync("git", ["init", "-q"], { cwd: projectRoot });
  const initialProfile = await copiedAuthenticatedProfile(`${label}-initial`);
  await installProfile(projectRoot, initialProfile);

  const upgradedProfile = await copiedAuthenticatedProfile(`${label}-upgraded`, async (root) => {
    const sourcePath = path.join(root, "koni", "baseline", resourcePath);
    await writeFile(
      sourcePath,
      rewritePiPackageDescription(await readFile(sourcePath, "utf8"), "upstream revision"),
    );
  });
  const projectPath = path.join(projectRoot, ".koni", resourcePath);
  await writeFile(
    projectPath,
    rewritePiPackageDescription(await readFile(projectPath, "utf8"), "project choice"),
  );
  const projectSha256 = rawSha256(await readFile(projectPath));
  await installProfile(projectRoot, upgradedProfile);
  return { projectRoot, upgradedProfile, projectSha256 };
}

function rewritePiPackageDescription(source: string, description: string): string {
  const document = YAML.parse(source) as { bindings?: Array<Record<string, unknown>> };
  if (!Array.isArray(document.bindings) || document.bindings.length === 0) {
    throw new Error("Pi package fixture lacks a binding");
  }
  document.bindings[0]!.description = description;
  return YAML.stringify(document);
}

async function authority(
  projectRoot: string,
  profilePackageRoot: string,
): Promise<{
  engine: RunAuthorityEngine;
  client: AuthorityClient;
}> {
  const engine = await RunAuthorityEngine.open({
    projectRoot,
    version: "1.0.0",
    program: {} as RunCompilerProgram,
    supervisor: new ManagedSessionSupervisor(),
    profilePackageRootLoader: async () => profilePackageRoot,
  });
  engines.push(engine);
  await engine.start();
  return {
    engine,
    client: await AuthorityClient.connect({ projectRoot, client: "tui", version: "1.0.0" }),
  };
}

async function copiedAuthenticatedProfile(
  label: string,
  mutate?: (packageRoot: string) => Promise<void>,
): Promise<string> {
  const packageRoot = await temporary(label);
  await cp(codingProfile, packageRoot, { recursive: true });
  await mutate?.(packageRoot);
  const manifestPath = path.join(packageRoot, "koni", "profile-manifest.json");
  const baselineRoot = path.join(packageRoot, "koni", "baseline");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProfilePackageManifest;
  const version = `${manifest.package.version}-test-${label}`;
  const profilePath = path.join(baselineRoot, "profile.yaml");
  await writeFile(
    profilePath,
    (await readFile(profilePath, "utf8")).replace(
      /^ {2}version: [^\n]+/mu,
      `  version: ${version}`,
    ),
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
  return packageRoot;
}

async function temporary(label: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), `koni-${label}-`)));
  roots.push(root);
  return root;
}
