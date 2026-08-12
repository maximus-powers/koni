import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createContainedResourceLoader,
  type ContainedResourceError,
} from "../src/pi/resource-loader.js";
import { fixtureLaunchSpec, fixtureResource } from "./pi-managed-fixtures.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
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
    const skill =
      "---\nname: issued-skill\ndescription: Compiler-issued procedure\n---\nFollow the ticket exactly.";
    const lifecycleSkill =
      "---\nname: lifecycle-skill\ndescription: Replans and obtains approval before implementation\n---\nRestart planning.";
    const skillReference = "# Reference\n\nUse the compiler-issued invariant.";
    const prompt = "---\ndescription: Compiler-issued operator prompt\n---\nDo the issued step.";
    const spec = fixtureLaunchSpec({
      cwd,
      sessionDirectory: path.join(root, "sessions", "attempt-one"),
      resources: [
        fixtureResource("skill", "issued-skill", "skills/issued-skill/SKILL.md", skill),
        fixtureResource(
          "skill",
          "lifecycle-skill",
          "skills/lifecycle-skill/SKILL.md",
          lifecycleSkill,
        ),
        fixtureResource(
          "skill",
          "issued-skill-reference",
          "skills/issued-skill/references/invariant.md",
          skillReference,
        ),
        fixtureResource("prompt", "issued-prompt", "prompts/issued-prompt.md", prompt),
        fixtureResource(
          "context",
          "issued-context",
          "context/ticket.md",
          "Authoritative ticket context.",
        ),
        fixtureResource(
          "append_system_prompt",
          "issued-append",
          "prompts/append.md",
          "Preserve receipts.",
        ),
      ],
    });
    const result = await createContainedResourceLoader({
      spec,
      extension: { name: "koni-managed-session", factory() {} },
    });

    expect(result.loader.getExtensions().extensions.map((entry) => entry.path)).toEqual([
      "<inline:koni-managed-session>",
    ]);
    expect(result.loader.getSkills().skills.map((entry) => entry.name)).toEqual([
      "issued-skill",
      "lifecycle-skill",
    ]);
    expect(result.loader.getPrompts().prompts.map((entry) => entry.name)).toEqual([
      "issued-prompt",
    ]);
    expect(result.loader.getThemes().themes).toEqual([]);
    expect(result.loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(result.loader.getAgentsFiles().agentsFiles).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "Authoritative ticket context." }),
      ]),
    );
    expect(result.loader.getAppendSystemPrompt()).toEqual([
      "Preserve receipts.",
      expect.stringContaining("<name>issued-skill</name>"),
    ]);
    expect(result.loader.getAppendSystemPrompt()[1]).toContain(
      "<location>skills/issued-skill/SKILL.md</location>",
    );
    expect(result.loader.getAppendSystemPrompt()[1]).toContain("<name>lifecycle-skill</name>");
    expect(result.loader.getAppendSystemPrompt()[1]).toContain("koni_read_resource");
    expect(result.loader.getAppendSystemPrompt()[1]).toContain(
      "Koni already owns scope, approval, orchestration, worktrees, and promotion",
    );
    expect(result.loader.getAppendSystemPrompt()[1]).toContain(
      "Use skills for techniques inside the issued step",
    );
    expect(result.loader.getAppendSystemPrompt()[1]).toContain(
      "Treat this contained attempt as a dispatched subagent task",
    );
    expect(result.loader.getAppendSystemPrompt()[1]).not.toContain(
      "load every skill whose description matches the task",
    );
    expect(result.loader.getAppendSystemPrompt()[1]).not.toContain("Follow the ticket exactly.");
    expect(result.loader.getSystemPrompt()).toBe(spec.persona.systemPrompt);
    expect(
      await readFile(
        path.join(result.resourceRoot, "skills/issued-skill/references/invariant.md"),
        "utf8",
      ),
    ).toBe(skillReference);
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
    await expect(
      createContainedResourceLoader({
        spec,
        extension: { name: "koni-managed-session", factory() {} },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "resource_replay" }));
  });

  it("recovers only when every previously materialized resource still matches its launch bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koni-contained-recovery-"));
    temporary.push(root);
    const cwd = path.join(root, "worktree");
    await mkdir(cwd);
    const resource = fixtureResource(
      "context",
      "ticket",
      "context/ticket.md",
      "Bound ticket context.",
    );
    const spec = fixtureLaunchSpec({
      cwd,
      sessionDirectory: path.join(root, "sessions", "attempt-recovery"),
      resources: [resource],
    });
    const extension = { name: "koni-managed-session", factory() {} } as const;
    const fresh = await createContainedResourceLoader({ spec, extension });

    await expect(
      createContainedResourceLoader({ spec, extension, mode: "recover" }),
    ).resolves.toEqual(expect.objectContaining({ resourceRoot: fresh.resourceRoot }));

    const materialized = path.join(fresh.resourceRoot, resource.relativePath);
    await chmod(materialized, 0o600);
    await writeFile(materialized, "drifted", "utf8");
    await chmod(materialized, 0o400);
    await expect(
      createContainedResourceLoader({ spec, extension, mode: "recover" }),
    ).rejects.toEqual(expect.objectContaining({ code: "resource_drift" }));
  });

  it("recreates a missing partial resource from the immutable launch bundle during recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koni-contained-partial-resource-"));
    temporary.push(root);
    const cwd = path.join(root, "worktree");
    await mkdir(cwd);
    const resource = fixtureResource(
      "context",
      "ticket",
      "context/nested/ticket.md",
      "Bound ticket context.",
    );
    const spec = fixtureLaunchSpec({
      cwd,
      sessionDirectory: path.join(root, "sessions", "attempt-partial-resource"),
      resources: [resource],
    });
    const extension = { name: "koni-managed-session", factory() {} } as const;
    const fresh = await createContainedResourceLoader({ spec, extension });
    const materialized = path.join(fresh.resourceRoot, resource.relativePath);
    await rm(path.dirname(materialized), { recursive: true });

    const recovered = await createContainedResourceLoader({ spec, extension, mode: "recover" });
    expect(recovered.resourceRoot).toBe(fresh.resourceRoot);
    expect(await readFile(materialized, "utf8")).toBe(resource.content);
  });

  it("rejects a nested symlink even when its target contains the expected resource bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koni-contained-symlink-"));
    temporary.push(root);
    const cwd = path.join(root, "worktree");
    await mkdir(cwd);
    const resource = fixtureResource(
      "context",
      "ticket",
      "context/ticket.md",
      "Bound ticket context.",
    );
    const spec = fixtureLaunchSpec({
      cwd,
      sessionDirectory: path.join(root, "sessions", "attempt-symlink"),
      resources: [resource],
    });
    const extension = { name: "koni-managed-session", factory() {} } as const;
    const fresh = await createContainedResourceLoader({ spec, extension });
    const nested = path.join(fresh.resourceRoot, "context");
    const external = path.join(root, "external-context");
    await mkdir(external);
    await writeFile(path.join(external, "ticket.md"), resource.content, { mode: 0o400 });
    await rm(nested, { recursive: true });
    await symlink(external, nested, "dir");

    await expect(
      createContainedResourceLoader({ spec, extension, mode: "recover" }),
    ).rejects.toEqual(expect.objectContaining({ code: "resource_recovery" }));
  });
});
