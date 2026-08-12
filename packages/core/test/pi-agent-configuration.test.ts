import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROFILE_CONFIGURATION_SCHEMA_VERSION } from "../src/contracts/configuration.js";
import {
  loadPiResolvedInventory,
  resolvePiAgentConfiguration,
  type PiAgentCatalog,
  type PiResolvedInventory,
} from "../src/pi/agent-configuration.js";

const inventory: PiResolvedInventory = {
  settings: {
    packages: [
      "git:github.com/obra/superpowers",
      { source: "npm:pi-safe-tools", extensions: ["extensions/search.ts"] },
    ],
    skills: [],
    extensions: [],
    prompts: [],
    themes: [],
  },
  resources: {
    skills: [
      resource("skill", "using-superpowers", "skills/using-superpowers/SKILL.md", "super"),
      resource("skill", "brainstorming", "skills/brainstorming/SKILL.md", "brain"),
      resource("skill", "project-context", ".pi/skills/project-context/SKILL.md", "project"),
    ],
    extensions: [
      resource("extension", "search", "extensions/search.ts", "extension"),
      resource("extension", "interactive-widget", "extensions/widget.ts", "widget"),
    ],
    prompts: [],
    themes: [],
    context: [resource("context", "agents", "AGENTS.md", "repository rules")],
  },
};

const agents: PiAgentCatalog = {
  base: {
    id: "base",
    instructions: "Act carefully.",
    pi: {
      provider: "openai-codex",
      model: "gpt-5.6-terra",
      thinking_level: "high",
      tools: { include: ["read", "grep", "find", "ls"] },
    },
    koni: {
      role: "worker",
      capabilities: { workspace_access: "read_only", network_access: false },
    },
  },
  planner: {
    id: "planner",
    extends: "base",
    instructions: "Plan the smallest sufficient change.",
    pi: {
      settings: {
        skills: ["skills/using-superpowers/**", "skills/brainstorming/**"],
        packages: [
          {
            source: "git:github.com/obra/superpowers",
            skills: ["skills/using-superpowers/**", "skills/brainstorming/**"],
            extensions: [],
          },
        ],
      },
    },
    koni: { role: "planner" },
  },
};

describe("Pi-native Koni agent configuration", () => {
  it("uses the hard-cutover profile schema", () => {
    expect(PROFILE_CONFIGURATION_SCHEMA_VERSION).toBe("3.0");
  });

  it("loads global and repository resources through Pi's native resolver", async () => {
    const root = await mkdtemp(join(tmpdir(), "koni-pi-agent-config-"));
    const agentDir = join(root, "pi-home");
    const project = join(root, "project");
    await mkdir(join(agentDir, "skills", "global-guide"), { recursive: true });
    await mkdir(join(project, ".pi", "skills", "project-guide"), { recursive: true });
    await writeFile(
      join(agentDir, "skills", "global-guide", "SKILL.md"),
      "---\nname: global-guide\ndescription: global\n---\nGlobal guidance.\n",
    );
    await writeFile(
      join(project, ".pi", "skills", "project-guide", "SKILL.md"),
      "---\nname: project-guide\ndescription: project\n---\nProject guidance.\n",
    );
    await writeFile(join(project, "AGENTS.md"), "Repository instructions.\n");

    const resolved = await loadPiResolvedInventory({ projectRoot: project, agentDir });

    expect(resolved.resources.skills.map((skill) => skill.id)).toEqual([
      "global-guide",
      "project-guide",
    ]);
    expect(resolved.resources.context).toEqual([
      expect.objectContaining({ id: "AGENTS.md", content: "Repository instructions.\n" }),
    ]);
  });

  it("honors Pi's native agent-directory override", async () => {
    const root = await mkdtemp(join(tmpdir(), "koni-pi-agent-dir-"));
    const agentDir = join(root, "pi-home");
    const project = join(root, "project");
    await mkdir(join(agentDir, "skills", "native-override"), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(
      join(agentDir, "skills", "native-override", "SKILL.md"),
      "---\nname: native-override\ndescription: native override\n---\nNative override guidance.\n",
    );

    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const resolved = await loadPiResolvedInventory({ projectRoot: project });
      expect(resolved.resources.skills).toEqual([
        expect.objectContaining({ id: "native-override", scope: "user" }),
      ]);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  it("inherits Pi's complete resolved repository environment when no agent filter is present", () => {
    const result = resolvePiAgentConfiguration({
      agentId: "base",
      agents,
      inventory,
      extensionAdapters: { "npm:pi-safe-tools::extensions/search.ts": "search.v1" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resources.skills.map((skill) => skill.id)).toEqual([
      "brainstorming",
      "project-context",
      "using-superpowers",
    ]);
    expect(result.value.resources.context).toHaveLength(1);
    expect(result.value.extensions).toEqual([
      expect.objectContaining({ id: "search", status: "compatible", adapter: "search.v1" }),
      expect.objectContaining({
        id: "interactive-widget",
        status: "excluded",
        reason: "interactive_only / excluded: no Koni adapter",
      }),
    ]);
    expect(result.value.tools.map((tool) => tool.name)).toEqual(["find", "grep", "ls", "read"]);
  });

  it("uses Pi's repository-local skill when a package exposes the same skill id", () => {
    const projectSkill = {
      ...resource("skill", "writing-skills", ".agents/skills/writing-skills/SKILL.md", "project"),
      source: "project",
    };
    const packageSkill = resource(
      "skill",
      "writing-skills",
      "skills/writing-skills/SKILL.md",
      "package",
    );
    const result = resolvePiAgentConfiguration({
      agentId: "base",
      agents,
      inventory: {
        ...inventory,
        resources: { ...inventory.resources, skills: [packageSkill, projectSkill] },
      },
      extensionAdapters: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resources.skills).toEqual([
      expect.objectContaining({ id: "writing-skills", source: "project", content: "project" }),
    ]);
  });

  it("applies one-parent inheritance and Pi package filters as a narrowing overlay", () => {
    const result = resolvePiAgentConfiguration({
      agentId: "planner",
      agents,
      inventory,
      extensionAdapters: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instructions).toBe("Plan the smallest sufficient change.");
    expect(result.value.model).toEqual({
      provider: "openai-codex",
      id: "gpt-5.6-terra",
      thinkingLevel: "high",
    });
    expect(result.value.resources.skills.map((skill) => skill.id)).toEqual([
      "brainstorming",
      "using-superpowers",
    ]);
    expect(result.value.resources.context).toHaveLength(1);
    expect(result.value.koni).toEqual({
      role: "planner",
      capabilities: { workspace_access: "read_only", network_access: false },
    });
    expect(result.value.configurationSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("fails closed when an agent tries to add a package or resource absent from Pi's inventory", () => {
    const adding: PiAgentCatalog = {
      rogue: {
        id: "rogue",
        instructions: "Do work.",
        pi: {
          settings: {
            packages: [
              { source: "npm:not-installed", skills: ["skills/rogue/**"] },
              { source: "git:github.com/obra/superpowers", skills: ["skills/not-real/**"] },
            ],
          },
        },
        koni: { role: "worker", capabilities: {} },
      },
    };

    const result = resolvePiAgentConfiguration({
      agentId: "rogue",
      agents: adding,
      inventory,
      extensionAdapters: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["agent.package_not_in_inventory", "agent.resource_not_in_inventory"]),
    );
  });

  it("rejects inheritance chains longer than one parent", () => {
    const result = resolvePiAgentConfiguration({
      agentId: "leaf",
      agents: {
        root: agents.base!,
        middle: { ...agents.base!, id: "middle", extends: "root" },
        leaf: { ...agents.base!, id: "leaf", extends: "middle" },
      },
      inventory,
      extensionAdapters: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "agent.extends_depth", path: "/agents/leaf/extends" }),
    ]);
  });
});

function resource(
  kind: "skill" | "extension" | "prompt" | "theme" | "context",
  id: string,
  relativePath: string,
  content: string,
) {
  return {
    kind,
    id,
    relativePath,
    absolutePath: `/project/${relativePath}`,
    content,
    source:
      relativePath.startsWith(".pi/") || relativePath === "AGENTS.md"
        ? "project"
        : kind === "extension"
          ? "npm:pi-safe-tools"
          : "git:github.com/obra/superpowers",
    scope: "project" as const,
  };
}
