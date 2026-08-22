import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(file) {
  return readFile(path.join(repositoryRoot, file), "utf8");
}

async function readJson(file) {
  return JSON.parse(await read(file));
}

test("the repository is a pinned pnpm Turborepo", async () => {
  const manifest = await readJson("package.json");
  assert.equal(manifest.packageManager, "pnpm@11.13.1");
  assert.equal(manifest.devDependencies?.turbo, "2.10.5");
  assert.equal(manifest.workspaces, undefined);
  assert.match(await read("pnpm-workspace.yaml"), /packages:\s*\n\s*- packages\/\*/u);
  const turbo = await readJson("turbo.json");
  for (const task of ["build", "typecheck", "test", "check"])
    assert.ok(turbo.tasks?.[task], `missing Turbo task ${task}`);
  await assert.rejects(access(path.join(repositoryRoot, "package-lock.json")));
  await access(path.join(repositoryRoot, "pnpm-lock.yaml"));
  await access(path.join(repositoryRoot, "scripts/fixtures/pi-host-package-lock.json"));
});

test("root scripts use Turbo instead of npm workspace orchestration", async () => {
  const { scripts } = await readJson("package.json");
  for (const [name, command] of Object.entries(scripts)) {
    assert.doesNotMatch(
      command,
      /npm run\b[^\n]*--workspace(?:s)?\b/u,
      `${name} still uses npm workspace orchestration`,
    );
  }
  for (const name of ["build", "typecheck", "test", "check"])
    assert.match(scripts[name], /turbo run\b/u, `${name} does not use Turbo`);
});

test("Turbo uses only the local cache", async () => {
  assert.match(await read(".gitignore"), /^\/\.turbo\/$/mu);
  const turbo = await readJson("turbo.json");
  assert.equal(Object.hasOwn(turbo, "remoteCache"), false);
});
