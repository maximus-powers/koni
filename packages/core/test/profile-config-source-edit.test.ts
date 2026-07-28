import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  catalogProjectAuthoredConfigSources,
  readProjectAuthoredConfigSource,
  updateProjectAuthoredConfigSources,
} from "../src/profile/config-edit.js";
import { installProfile } from "../src/profile/install.js";

const roots: string[] = [];
const codingProfile = path.resolve(import.meta.dirname, "../../coding-profile");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}, 30_000);

describe("raw project configuration source publication", () => {
  it("creates and atomically renames non-YAML sources while enforcing exact source CAS", async () => {
    const project = await initializedProject();
    const created = await updateProjectAuthoredConfigSources({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      sources: [
        {
          path: "resources/prompts/release-review.md",
          expectedSourceSha256: null,
          source: "# Release review\n",
          kind: "prompt",
        },
        {
          path: "custom/release.toml",
          expectedSourceSha256: null,
          source: "enabled = true\n",
          kind: "other",
        },
      ],
    });
    expect(created.documents).toHaveLength(2);
    const prompt = await readProjectAuthoredConfigSource(
      project,
      codingProfile,
      "resources/prompts/release-review.md",
    );
    expect(prompt.entry).toMatchObject({ format: "markdown", kind: "prompt" });
    await updateProjectAuthoredConfigSources({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      sources: [
        {
          path: prompt.entry.path,
          expectedSourceSha256: prompt.entry.sourceSha256,
          source: "# Release review\n\nCurrent.\n",
        },
      ],
    });
    await expect(
      updateProjectAuthoredConfigSources({
        projectRoot: project,
        profilePackageRoot: codingProfile,
        sources: [
          {
            path: prompt.entry.path,
            expectedSourceSha256: prompt.entry.sourceSha256,
            source: "stale\n",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "config_source_changed" });
    const currentPrompt = await readProjectAuthoredConfigSource(
      project,
      codingProfile,
      prompt.entry.path,
    );
    const renamed = await updateProjectAuthoredConfigSources({
      projectRoot: project,
      profilePackageRoot: codingProfile,
      sources: [
        {
          path: "resources/prompts/release-gate.md",
          expectedSourceSha256: null,
          source: currentPrompt.source,
          kind: "prompt",
        },
      ],
      deletes: [
        { path: currentPrompt.entry.path, expectedSourceSha256: currentPrompt.entry.sourceSha256 },
      ],
    });
    expect(renamed.documents[0]?.path).toBe("resources/prompts/release-gate.md");
    await expect(
      readProjectAuthoredConfigSource(project, codingProfile, prompt.entry.path),
    ).rejects.toMatchObject({ code: "config_not_editable" });
    await expect(
      updateProjectAuthoredConfigSources({
        projectRoot: project,
        profilePackageRoot: codingProfile,
        sources: [
          {
            path: "resources/prompts/release-review.md",
            expectedSourceSha256: prompt.entry.sourceSha256,
            source: "stale\n",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "config_not_editable" });
    const catalog = await catalogProjectAuthoredConfigSources(project, codingProfile);
    expect(catalog.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "resources/prompts/release-gate.md", format: "markdown" }),
        expect.objectContaining({ path: "custom/release.toml", format: "toml" }),
      ]),
    );
  }, 90_000);

  it("rolls back bytes and lifecycle bookkeeping when a raw delete breaks the full candidate", async () => {
    const project = await initializedProject();
    const workflow = await readProjectAuthoredConfigSource(
      project,
      codingProfile,
      "workflows.yaml",
    );
    const lifecyclePath = path.join(project, ".koni", ".managed", "lifecycle.json");
    const lifecycleBefore = await readFile(lifecyclePath, "utf8");
    await expect(
      updateProjectAuthoredConfigSources({
        projectRoot: project,
        profilePackageRoot: codingProfile,
        sources: [],
        deletes: [{ path: workflow.entry.path, expectedSourceSha256: workflow.entry.sourceSha256 }],
      }),
    ).rejects.toMatchObject({ code: "candidate_configuration_invalid" });
    expect(await readFile(path.join(project, ".koni", "workflows.yaml"), "utf8")).toBe(
      workflow.source,
    );
    expect(await readFile(lifecyclePath, "utf8")).toBe(lifecycleBefore);
  }, 60_000);
});

async function initializedProject(): Promise<string> {
  const project = await mkdtemp(path.join(tmpdir(), "koni-config-source-edit-"));
  roots.push(project);
  await installProfile(project, codingProfile);
  return project;
}
