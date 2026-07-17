import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalHash } from "../src/shared/canonical.js";
import {
  applyLegacyProjectMigration,
  LegacyProjectMigrationError,
  planLegacyProjectMigration,
  verifyLegacyRunCompatibility,
  type LegacyRunBarrierEvidence,
  type LegacyRunMigrationAuthority,
  type LegacyRunCompatibilityIndex,
} from "../src/profile/migration.js";
import { readProfileLifecycle } from "../src/profile/install.js";

const run = promisify(execFile);
const roots: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const codingProfile = path.join(repositoryRoot, "packages", "coding-profile");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}, 30_000);

describe("guarded Rust-era project and run migration", () => {
  it("previews and applies an archived, source-retaining schema-1 migration", async () => {
    const project = await legacyProject();
    const plan = await planLegacyProjectMigration({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      migrationId: "schema1-fixture",
      inspectRuns: false,
    });
    expect(plan.configuration.kind).toBe("codex_schema1");
    expect(plan.transformedFiles).toContainEqual(expect.objectContaining({ path: "profile.yaml" }));
    expect(plan.transformedFiles).toContainEqual(expect.objectContaining({ path: "agents/run-planner.yaml" }));
    await expect(readFile(path.join(project, ".koni", "profile.yaml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const result = await applyLegacyProjectMigration(plan, { profilePackageRoot: codingProfile });
    expect(result.sourceRetained).toBe(true);
    expect(await readFile(path.join(project, ".codex", "koni", "profile.yaml"), "utf8")).toContain("schema_version: \"1.0\"");
    expect(await readFile(path.join(project, ".koni", "profile.yaml"), "utf8")).toMatch(/schema_version: ["']?2\.0["']?/u);
    expect(await readFile(path.join(project, result.receiptPath), "utf8")).toContain(plan.planSha256);
    expect(await readFile(path.join(project, result.compatibilityPath), "utf8")).toContain("koni.legacy-run-compatibility.v1");
    const lifecycle = await readProfileLifecycle(project);
    expect(lifecycle?.migrations).toContainEqual(expect.objectContaining({ id: "schema1-fixture" }));
    expect(await readFile(path.join(project, ".koni", ".managed", "migrations", "schema1-fixture", "legacy-config", "project.yaml"), "utf8")).toContain("schema_version: \"1.0\"");
  }, 30_000);

  it("rejects source drift between the read-only plan and publication", async () => {
    const project = await legacyProject();
    const plan = await planLegacyProjectMigration({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      migrationId: "source-drift",
      inspectRuns: false,
    });
    await writeFile(path.join(project, ".codex", "koni", "project.yaml"), "changed: true\n");
    await expect(applyLegacyProjectMigration(plan, { profilePackageRoot: codingProfile })).rejects.toMatchObject({
      code: "migration_source_changed",
    } satisfies Partial<LegacyProjectMigrationError>);
  }, 30_000);

  it("adopts a complete unmanaged .koni tree only through the explicit migration path", async () => {
    const project = await temporary("unmanaged");
    await cp(path.join(codingProfile, "koni", "baseline"), path.join(project, ".koni"), { recursive: true });
    const plan = await planLegacyProjectMigration({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      migrationId: "unmanaged-adoption",
      inspectRuns: false,
    });
    expect(plan.configuration.kind).toBe("unmanaged_koni");
    const result = await applyLegacyProjectMigration(plan, { profilePackageRoot: codingProfile });
    expect(result.install.pendingUpstream).toEqual([]);
    expect((await readProfileLifecycle(project))?.migrations[0]?.id).toBe("unmanaged-adoption");
  }, 30_000);

  it("requires a held authority barrier and hash-binds resumable legacy run state", async () => {
    const project = await legacyProject();
    await run("git", ["init", "-q"], { cwd: project });
    const stateRoot = path.join(project, ".git", "koni");
    const runRoot = path.join(stateRoot, "runs", "active-run");
    await mkdir(runRoot, { recursive: true });
    await writeFile(path.join(runRoot, "state.yaml"), "stage: execute\n");
    await writeFile(path.join(stateRoot, "project.yaml"), `
selected_run: active-run
runs:
  active-run:
    status: active
    goal: Preserve this active run
    profile_id: software
    profile_version: 0.2.0
    run_type_id: medium
    target_branch: main
    base_commit: "0000000000000000000000000000000000000000"
    config_snapshot_hash: "legacy-config"
    created_at: "2026-07-01T00:00:00Z"
    updated_at: "2026-07-01T00:01:00Z"
`);
    const plan = await planLegacyProjectMigration({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      migrationId: "active-run-adapter",
    });
    expect(plan.runs.requiresBarrier).toBe(true);
    expect(plan.runs.runs[0]).toMatchObject({ status: "active", resumeDisposition: "execution_paused" });
    await expect(applyLegacyProjectMigration(plan, { profilePackageRoot: codingProfile })).rejects.toMatchObject({
      code: "run_authority_required",
    } satisfies Partial<LegacyProjectMigrationError>);

    let held = false;
    const authority: LegacyRunMigrationAuthority = {
      async withQuiescedRuns(request, publishWhileHeld) {
        held = true;
        const material = {
          ...request,
          quiescedAt: "2026-07-16T12:00:00.000Z",
          quiescedRunIds: request.runBindings.map(({ id }) => id),
        };
        const evidence: LegacyRunBarrierEvidence = {
          ...material,
          evidenceSha256: canonicalHash(material),
        };
        const result = await publishWhileHeld(evidence);
        expect(held).toBe(true);
        held = false;
        return result;
      },
    };
    const applied = await applyLegacyProjectMigration(plan, {
      profilePackageRoot: codingProfile,
      runAuthority: authority,
    });
    expect(held).toBe(false);
    const index = JSON.parse(await readFile(path.join(project, applied.compatibilityPath), "utf8")) as LegacyRunCompatibilityIndex;
    expect((await verifyLegacyRunCompatibility(index, "active-run")).resumeDisposition).toBe("execution_paused");
    await writeFile(path.join(runRoot, "state.yaml"), "stage: changed-after-migration\n");
    await expect(verifyLegacyRunCompatibility(index, "active-run")).rejects.toMatchObject({
      code: "legacy_run_changed",
    } satisfies Partial<LegacyProjectMigrationError>);
  }, 30_000);

  it("rejects symlinks in legacy configuration rather than following them", async () => {
    const project = await legacyProject();
    await symlink(path.join(project, ".codex", "koni", "profile.yaml"), path.join(project, ".codex", "koni", "alias.yaml"));
    await expect(planLegacyProjectMigration({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      inspectRuns: false,
    })).rejects.toMatchObject({ code: "legacy_symlink" } satisfies Partial<LegacyProjectMigrationError>);
  }, 30_000);
});

async function legacyProject(): Promise<string> {
  const project = await temporary("legacy");
  await mkdir(path.join(project, ".codex"), { recursive: true });
  await cp(path.join(repositoryRoot, ".codex", "koni"), path.join(project, ".codex", "koni"), { recursive: true });
  await cp(path.join(repositoryRoot, ".codex", "agents"), path.join(project, ".codex", "agents"), { recursive: true });
  return project;
}

async function temporary(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `koni-${label}-`));
  roots.push(root);
  return root;
}
