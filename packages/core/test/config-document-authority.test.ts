import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG_DOCUMENT_DOMAINS,
  CONFIG_RESOURCE_KINDS,
  ConfigDocumentAuthority,
} from "../src/authority/config-documents.js";
import { FileTransactionStore } from "../src/authority/file-journal.js";
import { installProfile } from "../src/profile/install.js";
import { rawSha256 } from "../src/shared/canonical.js";

const roots: string[] = [];
const codingProfile = path.resolve(import.meta.dirname, "../../coding-profile");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}, 30_000);

describe("standalone Configure document authority", () => {
  it("projects the complete semantic vocabulary while keeping raw paths authority-internal", async () => {
    const project = await initializedProject();
    const authority = new ConfigDocumentAuthority({
      projectRoot: project,
      profilePackageRoot: codingProfile,
    });
    const catalog = await authority.list();
    expect(CONFIG_DOCUMENT_DOMAINS).toHaveLength(9);
    expect(CONFIG_RESOURCE_KINDS).toHaveLength(29);
    expect(catalog).toMatchObject({ protocol: "koni.config-document-catalog.v1", valid: true });
    expect(catalog.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Software project",
          domain: "project",
          kind: "project",
          format: "yaml",
        }),
        expect.objectContaining({
          title: "Small",
          domain: "run_types",
          kind: "run_type",
          format: "yaml",
        }),
        expect.objectContaining({
          title: "Run Planner",
          domain: "agents",
          kind: "native_agent",
          format: "yaml",
        }),
        expect.objectContaining({ domain: "skills", kind: "skill", format: "markdown" }),
      ]),
    );
    expect(catalog.documents.some((document) => Object.hasOwn(document, "path"))).toBe(false);
    const projectDocument = catalog.documents.find((document) => document.kind === "project")!;
    const source = await authority.read({
      documentId: projectDocument.id,
      catalogToken: catalog.catalogToken,
    });
    expect(source.source).toContain("default_run_type: continuous-improvement");
    expect(source.document.capabilities).toMatchObject({
      update: true,
      rename: false,
      delete: false,
    });
  }, 60_000);

  it("keeps invalid YAML reachable and repairs it through exact source and catalog CAS", async () => {
    const project = await initializedProject();
    const graphPath = path.join(project, ".koni", "graph.yaml");
    const validSource = await readFile(graphPath, "utf8");
    await writeFile(graphPath, "node_types: [\n", "utf8");
    const authority = new ConfigDocumentAuthority({
      projectRoot: project,
      profilePackageRoot: codingProfile,
    });
    const broken = await authority.list();
    expect(broken.valid).toBe(false);
    expect(broken.diagnostics.length).toBeGreaterThan(0);
    const graph = broken.documents.find(
      (document) => document.domain === "graph_rules" && document.kind === "node_type",
    )!;
    const opened = await authority.read({
      documentId: graph.id,
      catalogToken: broken.catalogToken,
    });
    expect(opened.source).toBe("node_types: [\n");
    const repaired = await authority.update({
      documentId: graph.id,
      catalogToken: broken.catalogToken,
      sourceToken: graph.sourceToken,
      source: validSource,
    });
    expect(repaired.catalog.valid).toBe(true);
    await expect(
      authority.update({
        documentId: graph.id,
        catalogToken: broken.catalogToken,
        sourceToken: graph.sourceToken,
        source: validSource,
      }),
    ).rejects.toMatchObject({ code: "config_source_changed" });
  }, 90_000);

  it("creates, renames, updates, and deletes Markdown/TOML/YAML sources atomically", async () => {
    const project = await initializedProject();
    const authority = new ConfigDocumentAuthority({
      projectRoot: project,
      profilePackageRoot: codingProfile,
    });
    const initial = await authority.list();
    const created = await authority.create({
      catalogToken: initial.catalogToken,
      domain: "advanced",
      kind: "raw_source",
      format: "toml",
      title: "Release Notes",
      source: "enabled = true\n",
    });
    expect(
      await readFile(path.join(project, ".koni", "custom", "release-notes.toml"), "utf8"),
    ).toBe("enabled = true\n");
    await expect(
      authority.create({
        catalogToken: initial.catalogToken,
        domain: "advanced",
        kind: "raw_source",
        format: "yaml",
        title: "Stale",
      }),
    ).rejects.toMatchObject({ code: "config_source_changed" });

    const raw = created.catalog.documents.find((document) => document.title === "Release Notes")!;
    const renamed = await authority.rename({
      documentId: raw.id,
      catalogToken: created.catalog.catalogToken,
      sourceToken: raw.sourceToken,
      title: "Release Policy",
    });
    await expect(
      readFile(path.join(project, ".koni", "custom", "release-notes.toml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(path.join(project, ".koni", "custom", "release-policy.toml"), "utf8"),
    ).toBe("enabled = true\n");

    const renamedRaw = renamed.catalog.documents.find(
      (document) => document.title === "Release Policy",
    )!;
    const removed = await authority.delete({
      documentId: renamedRaw.id,
      catalogToken: renamed.catalog.catalogToken,
      sourceToken: renamedRaw.sourceToken,
    });
    expect(removed.catalog.valid).toBe(true);
    await expect(
      readFile(path.join(project, ".koni", "custom", "release-policy.toml")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const withSkill = await authority.create({
      catalogToken: removed.catalog.catalogToken,
      domain: "skills",
      kind: "skill",
      format: "markdown",
      title: "Review Incidents",
    });
    expect(withSkill.catalog.valid).toBe(true);
    expect(
      await readFile(
        path.join(project, ".koni", "resources", "skills", "review-incidents", "SKILL.md"),
        "utf8",
      ),
    ).toContain("# Review Incidents");
  }, 120_000);

  it("rolls back an invalid delete and rejects unsafe domain-kind-path combinations", async () => {
    const project = await initializedProject();
    const authority = new ConfigDocumentAuthority({
      projectRoot: project,
      profilePackageRoot: codingProfile,
    });
    const catalog = await authority.list();
    const workflow = catalog.documents.find((document) => document.kind === "workflow")!;
    const before = await readFile(path.join(project, ".koni", "workflows.yaml"), "utf8");
    const lifecycleBefore = await readFile(
      path.join(project, ".koni", ".managed", "lifecycle.json"),
      "utf8",
    );
    await expect(
      authority.delete({
        documentId: workflow.id,
        catalogToken: catalog.catalogToken,
        sourceToken: workflow.sourceToken,
      }),
    ).rejects.toMatchObject({ code: "candidate_configuration_invalid" });
    expect(await readFile(path.join(project, ".koni", "workflows.yaml"), "utf8")).toBe(before);
    expect(await readFile(path.join(project, ".koni", ".managed", "lifecycle.json"), "utf8")).toBe(
      lifecycleBefore,
    );
    await expect(
      authority.create({
        catalogToken: catalog.catalogToken,
        domain: "agents",
        kind: "skill",
        format: "markdown",
        title: "Escaping Skill",
      }),
    ).rejects.toMatchObject({ code: "config_document_kind" });
  }, 90_000);

  it("recovers exact committed results for every ordinary mutator after an outer-receipt crash", async () => {
    const project = await initializedProject();
    const authority = new ConfigDocumentAuthority({
      projectRoot: project,
      profilePackageRoot: codingProfile,
    });
    const initial = await authority.list();

    const createMarker = mutationMarker("1", "a");
    const createInput = {
      catalogToken: initial.catalogToken,
      domain: "advanced" as const,
      kind: "raw_source" as const,
      format: "markdown" as const,
      title: "Crash Journal",
      mutationMarker: createMarker,
    };
    const created = await authority.create(createInput);
    expect(
      (await authority.recoverMutation({ mutationMarker: createMarker }))?.changedDocuments,
    ).toBe(1);
    expect((await authority.create(createInput)).catalog.catalogToken).toBe(
      created.catalog.catalogToken,
    );
    await expect(
      authority.recoverMutation({
        mutationMarker: { ...createMarker, requestSha256: `sha256:${"b".repeat(64)}` },
      }),
    ).rejects.toMatchObject({ code: "config_mutation_replay" });

    const crashJournal = created.catalog.documents.find(
      (document) => document.title === "Crash Journal",
    )!;
    const renameMarker = mutationMarker("2", "b");
    const renamed = await authority.rename({
      documentId: crashJournal.id,
      catalogToken: created.catalog.catalogToken,
      sourceToken: crashJournal.sourceToken,
      title: "Recovery Journal",
      mutationMarker: renameMarker,
    });
    expect(
      (await authority.recoverMutation({ mutationMarker: renameMarker }))?.changedDocuments,
    ).toBe(2);
    await expect(authority.recoverMutation({ mutationMarker: createMarker })).rejects.toMatchObject(
      { code: "config_mutation_result_changed" },
    );

    const recoveryJournal = renamed.catalog.documents.find(
      (document) => document.title === "Recovery Journal",
    )!;
    const updateMarker = mutationMarker("3", "c");
    const updated = await authority.update({
      documentId: recoveryJournal.id,
      catalogToken: renamed.catalog.catalogToken,
      sourceToken: recoveryJournal.sourceToken,
      source: "# Recovery Journal\n\nCommitted before receipt.\n",
      mutationMarker: updateMarker,
    });
    expect(
      (await authority.recoverMutation({ mutationMarker: updateMarker }))?.changedDocuments,
    ).toBe(1);

    const updatedJournal = updated.catalog.documents.find(
      (document) => document.title === "Recovery Journal",
    )!;
    const deleteMarker = mutationMarker("4", "d");
    await authority.delete({
      documentId: updatedJournal.id,
      catalogToken: updated.catalog.catalogToken,
      sourceToken: updatedJournal.sourceToken,
      mutationMarker: deleteMarker,
    });
    expect(
      (await authority.recoverMutation({ mutationMarker: deleteMarker }))?.changedDocuments,
    ).toBe(1);

    const templates = await authority.runTypeTemplates();
    const small = templates.templates.find((template) => template.title === "Small")!;
    const runTypeMarker = mutationMarker("5", "e");
    await authority.createRunType({
      catalogToken: templates.catalogToken,
      templateId: small.id,
      title: "Receipt Safe",
      makeDefault: false,
      mutationMarker: runTypeMarker,
    });
    const markerPath = path.join(
      project,
      ".koni",
      ".managed",
      "config-mutations",
      `${runTypeMarker.id}.json`,
    );
    const markerBytes = await readFile(markerPath);
    const stranded = await FileTransactionStore.open(path.join(project, ".koni"));
    await stranded.prepare("committed-before-cleanup", [
      {
        path: `.managed/config-mutations/${runTypeMarker.id}.json`,
        bytes: markerBytes,
        expectedSha256: rawSha256(markerBytes),
      },
    ]);
    await stranded.commit("committed-before-cleanup");
    expect(await readdir(path.join(project, ".koni", ".transactions"))).toContain(
      "committed-before-cleanup",
    );
    expect(
      (await authority.recoverMutation({ mutationMarker: runTypeMarker }))?.changedDocuments,
    ).toBe(2);
    expect(await readdir(path.join(project, ".koni", ".transactions"))).toEqual([]);
    expect(
      await authority.recoverMutation({ mutationMarker: mutationMarker("6", "f") }),
    ).toBeUndefined();

    const storedMarker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    expect(storedMarker).toMatchObject({
      protocol: "koni.project-config-mutation-marker.v1",
      requestSha256: runTypeMarker.requestSha256,
      changedDocuments: 2,
      result: expect.objectContaining({
        lifecycleGeneration: expect.any(Number),
        sourceRevision: expect.stringMatching(/^sha256:/u),
        configurationSha256: expect.stringMatching(/^sha256:/u),
        effectiveBundleSha256: expect.stringMatching(/^sha256:/u),
      }),
    });
  }, 180_000);

  it("creates a standalone resolved run type from a current template and updates the default atomically", async () => {
    const project = await initializedProject();
    const authority = new ConfigDocumentAuthority({
      projectRoot: project,
      profilePackageRoot: codingProfile,
    });
    const templates = await authority.runTypeTemplates();
    const medium = templates.templates.find((template) => template.title === "Medium")!;
    const created = await authority.createRunType({
      catalogToken: templates.catalogToken,
      templateId: medium.id,
      title: "UI Feature",
      description: "A project-specific interface workflow.",
      makeDefault: true,
    });
    expect(created.changedDocuments).toBe(2);
    const projectSource = await readFile(path.join(project, ".koni", "project.yaml"), "utf8");
    expect(projectSource).toContain("default_run_type: ui-feature");
    expect(projectSource).toContain("path: run-types/ui-feature.yaml");
    const runType = await readFile(
      path.join(project, ".koni", "run-types", "ui-feature.yaml"),
      "utf8",
    );
    expect(runType).toContain("id: ui-feature");
    expect(runType).toContain("title: UI Feature");
    expect(runType).toContain("combined-plan:");
    expect(runType).not.toContain("extends:");
    const uiFeature = created.catalog.documents.find(
      (document) => document.title === "UI Feature",
    )!;
    const renamed = await authority.rename({
      documentId: uiFeature.id,
      catalogToken: created.catalog.catalogToken,
      sourceToken: uiFeature.sourceToken,
      title: "Interface Feature",
    });
    expect(await readFile(path.join(project, ".koni", "project.yaml"), "utf8")).toContain(
      "default_run_type: interface-feature",
    );
    expect(
      await readFile(path.join(project, ".koni", "run-types", "interface-feature.yaml"), "utf8"),
    ).toContain("id: interface-feature");
    const interfaceFeature = renamed.catalog.documents.find(
      (document) => document.title === "Interface Feature",
    )!;
    const deleted = await authority.delete({
      documentId: interfaceFeature.id,
      catalogToken: renamed.catalog.catalogToken,
      sourceToken: interfaceFeature.sourceToken,
    });
    expect(deleted.catalog.valid).toBe(true);
    expect(await readFile(path.join(project, ".koni", "project.yaml"), "utf8")).toContain(
      "default_run_type: small",
    );
    await expect(
      readFile(path.join(project, ".koni", "run-types", "interface-feature.yaml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      authority.createRunType({
        catalogToken: templates.catalogToken,
        templateId: medium.id,
        title: "Stale Template",
        makeDefault: false,
      }),
    ).rejects.toMatchObject({ code: "config_source_changed" });
  }, 120_000);
});

async function initializedProject(): Promise<string> {
  const project = await temporary("config-document-authority");
  await mkdir(path.join(project, ".pi"), { recursive: true });
  await writeFile(path.join(project, ".pi", "settings.json"), '{"theme":"mine"}\n');
  await installProfile(project, codingProfile);
  return project;
}

async function temporary(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `koni-${label}-`));
  roots.push(root);
  return root;
}

function mutationMarker(idCharacter: string, requestCharacter: string) {
  return {
    id: idCharacter.repeat(64),
    requestSha256: `sha256:${requestCharacter.repeat(64)}` as const,
  };
}
