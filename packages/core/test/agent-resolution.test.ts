import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileProfileConfiguration } from "../src/compiler/configuration.js";
import {
  parseProfilePackageManifest,
  type VerifiedProfileBaseline,
} from "../src/compiler/profile-package.js";
import { resolveCompiledAgent } from "../src/compiler/resolution.js";
import type { CompiledConfiguration, ConfigurationObject } from "../src/contracts/configuration.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const defaultAgentSkills = [
  "skills/brainstorming/**",
  "dist/skills/configure-koni/**",
  "skills/dispatching-parallel-agents/**",
  "skills/executing-plans/**",
  "skills/finishing-a-development-branch/**",
  "dist/skills/model-koni-work/**",
  "dist/skills/operate-koni/**",
  "skills/receiving-code-review/**",
  "skills/requesting-code-review/**",
  "skills/subagent-driven-development/**",
  "skills/systematic-debugging/**",
  "skills/test-driven-development/**",
  "skills/using-git-worktrees/**",
  "skills/using-superpowers/**",
  "skills/verification-before-completion/**",
  "skills/writing-plans/**",
  "skills/writing-skills/**",
] as const;

describe("compiled agent resolution", () => {
  it("uses the run-type role provider with its selected model", () => {
    const configuration = compileProfile("coding-profile");
    const runType = configuration.run_types.small!;
    const agents = runType.document.agents as ConfigurationObject;
    const roles = agents.roles as ConfigurationObject;
    const planner = roles.planner as ConfigurationObject;
    const document = {
      ...runType.document,
      agents: {
        ...agents,
        roles: {
          ...roles,
          planner: {
            ...planner,
            provider: "anthropic",
            model: "claude-haiku-4-5",
          },
        },
      },
    };
    const configured: CompiledConfiguration = {
      ...configuration,
      run_types: {
        ...configuration.run_types,
        small: { ...runType, document },
      },
    };

    const resolved = resolveCompiledAgent(configured, "run-planner", { runTypeId: "small" });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("keeps skills out of agent documents so Pi remains their source of truth", () => {
    for (const packageDirectory of ["coding-profile", "research-profile"]) {
      const configuration = compileProfile(packageDirectory);
      expect(configuration.modules).not.toHaveProperty("personas");
      for (const [agentId, resource] of Object.entries(configuration.agents)) {
        expect(resource.document, `${packageDirectory}/${agentId}`).not.toHaveProperty("skills");
        expect(resource.document).toHaveProperty("pi");
        expect(resource.document).toHaveProperty("koni");
        expect(resource.document).toHaveProperty("pi.settings.skills", defaultAgentSkills);
        const resolved = resolveCompiledAgent(configuration, agentId);
        expect(resolved.ok, `${packageDirectory}/${agentId}`).toBe(true);
      }
    }
  });
});

function compileProfile(packageDirectory: string): CompiledConfiguration {
  const result = compileProfileConfiguration(readBaseline(packageDirectory));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
}

function readBaseline(packageDirectory: string): VerifiedProfileBaseline {
  const packageRoot = resolve(repositoryRoot, "packages", packageDirectory, "koni");
  const manifest = parseProfilePackageManifest(
    readFileSync(join(packageRoot, "profile-manifest.json"), "utf8"),
  );
  if (!manifest.ok) throw new Error(JSON.stringify(manifest.diagnostics));
  return { manifest: manifest.value, files: readTree(join(packageRoot, "baseline")) };
}

function readTree(root: string): ReadonlyMap<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile())
        files.set(relative(root, path).split(sep).join("/"), readFileSync(path));
    }
  };
  visit(root);
  return files;
}
