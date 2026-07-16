import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContainedResourceLoader, ContainedResourceError } from "../src/pi/resource-loader.js";
import { fixtureLaunchSpec, fixtureResource } from "./pi-managed-fixtures.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("contained Pi resource loader", () => {
  it("loads only hash-bound issued resources and one inline extension", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koni-contained-resources-"));
    temporary.push(root);
    const cwd = path.join(root, "worktree");
    await mkdir(path.join(cwd, ".pi", "skills", "ambient"), { recursive: true });
    await writeFile(path.join(cwd, "AGENTS.md"), "ambient project context", "utf8");
    await writeFile(
      path.join(cwd, ".pi", "skills", "ambient", "SKILL.md"),
      "---\nname: ambient\ndescription: must not load\n---\nAmbient.",
      "utf8",
    );
    const skill = "---\nname: issued-skill\ndescription: Compiler-issued procedure\n---\nFollow the ticket exactly.";
    const prompt = "---\ndescription: Compiler-issued operator prompt\n---\nDo the issued step.";
    const spec = fixtureLaunchSpec({
      cwd,
      sessionDirectory: path.join(root, "sessions", "attempt-one"),
      resources: [
        fixtureResource("skill", "issued-skill", "skills/issued-skill/SKILL.md", skill),
        fixtureResource("prompt", "issued-prompt", "prompts/issued-prompt.md", prompt),
        fixtureResource("context", "issued-context", "context/ticket.md", "Authoritative ticket context."),
        fixtureResource("append_system_prompt", "issued-append", "prompts/append.md", "Preserve receipts."),
      ],
    });
    const result = await createContainedResourceLoader({
      spec,
      extension: { name: "koni-managed-session", factory() {} },
    });

    expect(result.loader.getExtensions().extensions.map((entry) => entry.path)).toEqual([
      "<inline:koni-managed-session>",
    ]);
    expect(result.loader.getSkills().skills.map((entry) => entry.name)).toEqual(["issued-skill"]);
    expect(result.loader.getPrompts().prompts.map((entry) => entry.name)).toEqual(["issued-prompt"]);
    expect(result.loader.getThemes().themes).toEqual([]);
    expect(result.loader.getAgentsFiles().agentsFiles).toEqual([
      expect.objectContaining({ content: "Authoritative ticket context." }),
    ]);
    expect(result.loader.getAppendSystemPrompt()).toEqual(["Preserve receipts."]);
    expect(result.loader.getSystemPrompt()).toBe(spec.persona.systemPrompt);
    expect(() => result.loader.extendResources({ skillPaths: [] })).toThrowError(
      expect.objectContaining({ code: "resource_extension_denied" }),
    );
    await expect(result.loader.reload()).rejects.toEqual(
      expect.objectContaining<Partial<ContainedResourceError>>({ code: "resource_reload_denied" }),
    );
  });

  it("rejects replaying a resource directory for the same immutable attempt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koni-contained-replay-"));
    temporary.push(root);
    const cwd = path.join(root, "worktree");
    await mkdir(cwd);
    const spec = fixtureLaunchSpec({
      cwd,
      sessionDirectory: path.join(root, "sessions", "attempt-one"),
    });
    await createContainedResourceLoader({
      spec,
      extension: { name: "koni-managed-session", factory() {} },
    });
    await expect(createContainedResourceLoader({
      spec,
      extension: { name: "koni-managed-session", factory() {} },
    })).rejects.toEqual(expect.objectContaining({ code: "resource_replay" }));
  });
});
