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

test("current source workflows use pnpm for repository orchestration", async () => {
  const operationalFiles = [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    "scripts/install-dev.sh",
    "CONTRIBUTING.md",
    "README.md",
    "docs/getting-started.md",
  ];

  for (const file of operationalFiles) {
    const source = await read(file);
    assert.doesNotMatch(source, /npm ci\b/u, `${file} installs the source checkout with npm`);
    assert.doesNotMatch(
      source,
      /npm run (?:check|build)\b/u,
      `${file} orchestrates the repository with npm`,
    );
  }
});

test("CI workflows set up and cache the pinned pnpm version", async () => {
  for (const file of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
    const workflow = await read(file);
    assert.match(workflow, /uses: pnpm\/action-setup@v4\s*\n\s+with:\s*\n\s+version: 11\.13\.1/u);
    assert.match(workflow, /cache: pnpm\b/u);
  }
});
