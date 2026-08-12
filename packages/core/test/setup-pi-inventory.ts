import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

const coreRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = await mkdtemp(path.join(tmpdir(), "koni-pi-inventory-"));
const agentDir = path.join(fixtureRoot, "agent");
const corePackage = path.join(fixtureRoot, "koni-core-package");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

await mkdir(agentDir, { recursive: true });
await mkdir(path.join(corePackage, "dist"), { recursive: true });
await cp(path.join(coreRoot, "skills"), path.join(corePackage, "dist", "skills"), {
  recursive: true,
});
await writeFile(
  path.join(corePackage, "package.json"),
  `${JSON.stringify(
    {
      name: "@koni/core-test-fixture",
      version: "1.0.0",
      pi: { skills: ["./dist/skills"] },
    },
    null,
    2,
  )}\n`,
);
await writeFile(
  path.join(agentDir, "settings.json"),
  `${JSON.stringify({ packages: [corePackage] }, null, 2)}\n`,
);

for (const name of [
  "brainstorming",
  "dispatching-parallel-agents",
  "executing-plans",
  "finishing-a-development-branch",
  "receiving-code-review",
  "requesting-code-review",
  "subagent-driven-development",
  "systematic-debugging",
  "test-driven-development",
  "using-git-worktrees",
  "using-superpowers",
  "verification-before-completion",
  "writing-plans",
  "writing-skills",
]) {
  const skillRoot = path.join(agentDir, "skills", name);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    path.join(skillRoot, "SKILL.md"),
    `---\nname: ${name}\ndescription: Hermetic Superpowers test resource.\n---\n\nTest-only package resource.\n`,
  );
}

process.env.PI_CODING_AGENT_DIR = agentDir;

afterAll(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(fixtureRoot, { recursive: true, force: true });
});
