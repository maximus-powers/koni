import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildConfigSurfaceCatalog,
  buildConfigSurfaceSnapshot,
  createConfigSurfaceResource,
  deleteConfigSurfaceResource,
  duplicateConfigSurfaceResource,
  publishConfigSurfaceSnapshot,
  recoverConfigSurfaceResourceMutation,
} from "../src/authority/config-surface.js";
import { installProfile, readProjectAuthoredConfigDocument } from "../src/index.js";
import type { JsonValue } from "../src/authority/protocol.js";

const roots: string[] = [];
const codingProfile = path.resolve(import.meta.dirname, "../../coding-profile");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}, 30_000);

describe("guided control-center configuration projection", () => {
  it("groups semantic resources and publishes opaque structured fields under CAS", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "koni-config-surface-"));
    roots.push(project);
    await installProfile(project, codingProfile);
    const catalog = await buildConfigSurfaceCatalog(project, codingProfile);
    expect(catalog.sections.map((section) => section.title)).toEqual(expect.arrayContaining([
      "Run Types",
      "Agents",
      "Context Graph",
      "Ticket Types",
    ]));
    const agents = catalog.sections.find((section) => section.title === "Agents")!;
    const planner = agents.resources.find((resource) => resource.title === "Run Planner")!;
    expect(planner.fields.map((field) => field.label)).toEqual(expect.arrayContaining([
      "Prompt",
      "Model",
      "Reasoning",
    ]));
    expect(planner.fields.every((field) => !field.key.includes("agents/") && !field.key.includes(".yaml"))).toBe(true);

    const projectSection = catalog.sections.find((section) => section.title === "Project")!;
    const indexedRunTypes = projectSection.resources.filter((resource) =>
      resource.fields.some((field) => field.label === "Path") &&
      resource.fields.some((field) => field.label === "Id"));
    expect(indexedRunTypes.length).toBeGreaterThan(0);
    expect(indexedRunTypes.every((resource) =>
      resource.canDuplicate !== true && resource.canDelete !== true)).toBe(true);

    const runTypes = catalog.sections.find((section) => section.title === "Run Types")!;
    const patchOperations = runTypes.resources.filter((resource) =>
      resource.fields.some((field) => field.label === "Op") &&
      resource.fields.some((field) => field.label === "Path"));
    expect(patchOperations.length).toBeGreaterThan(0);
    expect(patchOperations.every((resource) =>
      resource.canDuplicate !== true && resource.canDelete !== true)).toBe(true);

    const graph = catalog.sections.find((section) => section.title === "Context Graph")!;
    const edge = graph.resources.find((resource) =>
      resource.fields.some((field) => field.label === "Relation"))!;
    expect(edge).toMatchObject({ canDuplicate: true, canDelete: true });

    const snapshot = await buildConfigSurfaceSnapshot(project, codingProfile);
    const description = planner.fields.find((field) => field.label === "Description")!;
    const values = structuredClone(snapshot.values) as Record<string, JsonValue>;
    values[description.key] = "Configured through the Koni control center.";
    const updated = await publishConfigSurfaceSnapshot({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      cas: snapshot.cas,
      values,
    });
    expect(updated.changedDocuments).toBe(1);
    const source = await readProjectAuthoredConfigDocument(project, codingProfile, "agents/run-planner.yaml");
    expect(source.document.description).toBe("Configured through the Koni control center.");
    await expect(publishConfigSurfaceSnapshot({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      cas: snapshot.cas,
      values,
    })).rejects.toMatchObject({ code: "config_source_changed" });
  }, 90_000);

  it("creates, duplicates, deletes, recompiles, and crash-recovers semantic resources", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "koni-config-collections-"));
    roots.push(project);
    await installProfile(project, codingProfile);
    const initialCatalog = await buildConfigSurfaceCatalog(project, codingProfile);
    const initialSnapshot = await buildConfigSurfaceSnapshot(project, codingProfile);
    const runTypes = initialCatalog.sections.find((section) => section.title === "Run Types")!;
    const small = runTypes.resources.find((resource) => resource.title === "Small")!;
    const template = runTypes.createOptions!.find((option) => option.title === "Based on Small")!;
    const marker = {
      id: "a".repeat(64),
      requestSha256: `sha256:${"b".repeat(64)}` as const,
    };
    const created = await createConfigSurfaceResource({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      cas: initialSnapshot.cas,
      sectionId: runTypes.id,
      templateId: template.id,
      name: "Tiny Flow",
      mutationMarker: marker,
    });
    expect(created.changedDocuments).toBe(2);
    expect(await readFile(path.join(project, ".koni", "run-types", "tiny-flow.yaml"), "utf8"))
      .toContain("id: tiny-flow");
    const projectDocument = await readProjectAuthoredConfigDocument(project, codingProfile, "project.yaml");
    expect(projectDocument.document.run_types).toContainEqual({ id: "tiny-flow", path: "run-types/tiny-flow.yaml" });
    const recovered = await recoverConfigSurfaceResourceMutation({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      mutationMarker: marker,
    });
    expect(recovered?.changedDocuments).toBe(0);
    await expect(createConfigSurfaceResource({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      cas: initialSnapshot.cas,
      sectionId: runTypes.id,
      templateId: template.id,
      name: "Stale Flow",
    })).rejects.toMatchObject({ code: "config_source_changed" });

    const createdRunTypes = created.catalog.sections.find((section) => section.title === "Run Types")!;
    const tiny = createdRunTypes.resources.find((resource) => resource.title === "Tiny Flow")!;
    const duplicated = await duplicateConfigSurfaceResource({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      cas: created.snapshot.cas,
      resourceId: tiny.id,
      name: "Tiny Flow Copy",
    });
    expect(await readFile(path.join(project, ".koni", "run-types", "tiny-flow-copy.yaml"), "utf8"))
      .toContain("id: tiny-flow-copy");
    const duplicatedRunTypes = duplicated.catalog.sections.find((section) => section.title === "Run Types")!;
    const copy = duplicatedRunTypes.resources.find((resource) => resource.title === "Tiny Flow Copy")!;
    const deleted = await deleteConfigSurfaceResource({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      cas: duplicated.snapshot.cas,
      resourceId: copy.id,
    });
    expect(deleted.changedDocuments).toBe(2);
    await expect(readFile(path.join(project, ".koni", "run-types", "tiny-flow-copy.yaml")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const graph = deleted.catalog.sections.find((section) => section.title === "Context Graph")!;
    const sourceEdge = graph.resources.find((resource) =>
      resource.fields.some((field) => field.label === "Relation") && resource.canDuplicate === true)!;
    const edgeClone = await duplicateConfigSurfaceResource({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      cas: deleted.snapshot.cas,
      resourceId: sourceEdge.id,
      name: "Companion Link",
    });
    const graphSource = await readProjectAuthoredConfigDocument(project, codingProfile, "graph.yaml");
    expect(graphSource.document.edge_types).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: "companion-link" }),
    ]));
    const clonedEdge = edgeClone.catalog.sections.find((section) => section.title === "Context Graph")!
      .resources.find((resource) => resource.title === "Companion Link")!;
    expect(clonedEdge).toMatchObject({ canDuplicate: true, canDelete: true });
  }, 90_000);
});
