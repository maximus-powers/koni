import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const codingSkills = path.join(
  repositoryRoot,
  "packages/coding-profile/koni/baseline/resources/skills",
);
const researchSkills = path.join(
  repositoryRoot,
  "packages/research-profile/koni/baseline/resources/skills",
);
const destination = path.join(repositoryRoot, "packages/core/dist/skills");

const [codingInventory, researchInventory] = await Promise.all([
  inventory(codingSkills),
  inventory(researchSkills),
]);
assert.deepEqual(
  researchInventory,
  codingInventory,
  "shared Koni operator skills must stay byte-identical across profiles",
);
assert.equal(codingInventory.length, 18, "the shared Koni skill bundle must contain 18 files");
assert.deepEqual(
  codingInventory.filter(({ relative }) => relative.endsWith("/SKILL.md")).map(({ relative }) => relative),
  ["configure-koni/SKILL.md", "model-koni-work/SKILL.md", "operate-koni/SKILL.md"],
  "Core must publish exactly the three general Koni skills",
);

await rm(destination, { recursive: true, force: true });
await mkdir(path.dirname(destination), { recursive: true });
await cp(codingSkills, destination, { recursive: true });
assert.deepEqual(await inventory(destination), codingInventory, "the published Core skill bundle must be exact");

async function inventory(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await inventory(root, absolute));
    } else if (entry.isFile()) {
      files.push({
        relative: path.relative(root, absolute).split(path.sep).join("/"),
        bytes: (await readFile(absolute)).toString("base64"),
      });
    }
  }
  return files;
}
