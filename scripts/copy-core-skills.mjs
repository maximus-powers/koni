import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const source = path.join(repositoryRoot, "packages/core/skills");
const destination = path.join(repositoryRoot, "packages/core/dist/skills");

const sourceInventory = await inventory(source);
assert.deepEqual(
  sourceInventory
    .filter(({ relative }) => relative.endsWith("/SKILL.md"))
    .map(({ relative }) => relative),
  ["configure-koni/SKILL.md", "model-koni-work/SKILL.md", "operate-koni/SKILL.md"],
  "Core's Pi package must publish only Koni's three native skills",
);

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const skillName of ["configure-koni", "model-koni-work", "operate-koni"]) {
  await cp(path.join(source, skillName), path.join(destination, skillName), {
    recursive: true,
  });
}
assert.deepEqual(
  await inventory(destination),
  sourceInventory,
  "Core must publish only the exact Koni operator skill bytes",
);

async function inventory(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await inventory(root, absolute)));
    } else if (entry.isFile()) {
      files.push({
        relative: path.relative(root, absolute).split(path.sep).join("/"),
        bytes: (await readFile(absolute)).toString("base64"),
      });
    }
  }
  return files;
}
