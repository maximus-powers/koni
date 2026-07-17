import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  catalogProjectAuthoredConfig,
  ProjectConfigMutationError,
  readProjectAuthoredConfigDocument,
  updateProjectAuthoredConfigDocument,
  updateProjectAuthoredConfigDocuments,
} from "../src/profile/config-edit.js";
import { installProfile, readProfileLifecycle } from "../src/profile/install.js";

const roots: string[] = [];
const codingProfile = path.resolve(import.meta.dirname, "../../coding-profile");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}, 30_000);

describe("lifecycle-owned structured project configuration edits", () => {
  it("catalogs semantic YAML domains without exposing compiler or ambient Pi state", async () => {
    const project = await initializedProject();
    const catalog = await catalogProjectAuthoredConfig(project, codingProfile);
    expect(catalog.protocol).toBe("koni.project-config-catalog.v1");
    expect(catalog.profileId).toBe("software");
    expect(catalog.entries.find(({ path: relative }) => relative === "project.yaml")).toMatchObject({
      semanticDomain: "project",
      guidedEditable: true,
      kind: "config",
    });
    expect(catalog.entries.find(({ path: relative }) => relative === "run-types/small.yaml")).toMatchObject({
      semanticDomain: "run-type",
      guidedEditable: true,
    });
    expect(catalog.entries.find(({ path: relative }) => relative === "agents/run-planner.yaml")).toMatchObject({
      semanticDomain: "agent",
      guidedEditable: true,
    });
    expect(catalog.entries.some(({ path: relative }) => relative.startsWith(".managed/"))).toBe(false);
    expect(catalog.entries.some(({ path: relative }) => relative.startsWith(".pi/"))).toBe(false);
  }, 30_000);

  it("publishes one complete valid document and bookkeeping in one source-hash CAS", async () => {
    const project = await initializedProject();
    const before = await readProjectAuthoredConfigDocument(project, codingProfile, "project.yaml");
    const description = "Project-owned guided configuration description.";
    const document = structuredClone(before.document);
    (document.project as Record<string, unknown>).description = description;

    const result = await updateProjectAuthoredConfigDocument({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      path: "project.yaml",
      expectedSourceSha256: before.entry.sourceSha256,
      document,
    });
    expect(result.protocol).toBe("koni.project-config-update.v1");
    expect(result.sourceSha256).not.toBe(before.entry.sourceSha256);
    expect(result.lifecycleGeneration).toBe(before.catalog.lifecycleGeneration + 1);
    const after = await readProjectAuthoredConfigDocument(project, codingProfile, "project.yaml");
    expect((after.document.project as Record<string, unknown>).description).toBe(description);
    expect(after.catalog.configurationSha256).toBe(result.configurationSha256);
    expect(after.catalog.effectiveBundleSha256).toBe(result.effectiveBundleSha256);
    expect((await readProfileLifecycle(project))?.overlay).toContainEqual(expect.objectContaining({
      path: "project.yaml",
      disposition: "modified",
      projectSha256: result.sourceSha256,
    }));
    expect(await readFile(path.join(project, ".pi", "settings.json"), "utf8")).toBe('{"theme":"mine"}\n');
  }, 30_000);

  it("rejects stale editors and invalid complete candidates without changing bytes", async () => {
    const project = await initializedProject();
    const before = await readProjectAuthoredConfigDocument(project, codingProfile, "project.yaml");
    const originalSource = await readFile(path.join(project, ".koni", "project.yaml"), "utf8");
    const originalLifecycle = await readFile(path.join(project, ".koni", ".managed", "lifecycle.json"), "utf8");

    const invalid = structuredClone(before.document);
    invalid.default_run_type = "does-not-exist";
    await expect(updateProjectAuthoredConfigDocument({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      path: "project.yaml",
      expectedSourceSha256: before.entry.sourceSha256,
      document: invalid,
    })).rejects.toMatchObject({ code: "candidate_configuration_invalid" } satisfies Partial<ProjectConfigMutationError>);
    expect(await readFile(path.join(project, ".koni", "project.yaml"), "utf8")).toBe(originalSource);
    expect(await readFile(path.join(project, ".koni", ".managed", "lifecycle.json"), "utf8")).toBe(originalLifecycle);

    const valid = structuredClone(before.document);
    (valid.project as Record<string, unknown>).description = "First accepted edit";
    await updateProjectAuthoredConfigDocument({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      path: "project.yaml",
      expectedSourceSha256: before.entry.sourceSha256,
      document: valid,
    });
    await expect(updateProjectAuthoredConfigDocument({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      path: "project.yaml",
      expectedSourceSha256: before.entry.sourceSha256,
      document: before.document,
    })).rejects.toMatchObject({ code: "config_source_changed" } satisfies Partial<ProjectConfigMutationError>);
  }, 30_000);

  it("never accepts direct edits to lifecycle-owned paths", async () => {
    const project = await initializedProject();
    await expect(updateProjectAuthoredConfigDocument({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      path: ".managed/lifecycle.yaml",
      expectedSourceSha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      document: {},
    })).rejects.toMatchObject({ code: "config_path" } satisfies Partial<ProjectConfigMutationError>);
  }, 30_000);

  it("validates and publishes several guided documents as one transaction", async () => {
    const project = await initializedProject();
    const projectDocument = await readProjectAuthoredConfigDocument(project, codingProfile, "project.yaml");
    const agentDocument = await readProjectAuthoredConfigDocument(project, codingProfile, "agents/run-planner.yaml");
    const nextProject = structuredClone(projectDocument.document);
    const nextAgent = structuredClone(agentDocument.document);
    (nextProject.project as Record<string, unknown>).description = "Edited together";
    nextAgent.description = "Plans with an explicitly configured description.";
    const result = await updateProjectAuthoredConfigDocuments({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      documents: [
        {
          path: projectDocument.entry.path,
          expectedSourceSha256: projectDocument.entry.sourceSha256,
          document: nextProject,
        },
        {
          path: agentDocument.entry.path,
          expectedSourceSha256: agentDocument.entry.sourceSha256,
          document: nextAgent,
        },
      ],
    });
    expect(result.protocol).toBe("koni.project-config-batch-update.v1");
    expect(result.documents).toHaveLength(2);
    expect((await readProjectAuthoredConfigDocument(project, codingProfile, "agents/run-planner.yaml")).document)
      .toMatchObject({ description: "Plans with an explicitly configured description." });
  }, 30_000);
});

async function initializedProject(): Promise<string> {
  const project = await mkdtemp(path.join(tmpdir(), "koni-config-edit-"));
  roots.push(project);
  await mkdir(path.join(project, ".pi"), { recursive: true });
  await writeFile(path.join(project, ".pi", "settings.json"), '{"theme":"mine"}\n');
  await installProfile(project, codingProfile);
  return project;
}
