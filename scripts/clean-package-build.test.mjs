import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./clean-package-build.mjs", import.meta.url));

test("clean-package-build removes only a declared real dist directory", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "koni-clean-build-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "@koni/example", files: ["dist"] })}\n`,
  );
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "stale.js"), "stale\n");

  await execFileAsync(process.execPath, [scriptPath, root]);

  await assert.rejects(readFile(path.join(root, "dist", "stale.js")));
  assert.equal(
    await readFile(path.join(root, "package.json"), "utf8"),
    '{"name":"@koni/example","files":["dist"]}\n',
  );
});

test("clean-package-build rejects a symbolic-link output", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "koni-clean-build-link-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const outside = await mkdtemp(path.join(tmpdir(), "koni-clean-build-outside-"));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "@koni/example", files: ["dist"] })}\n`,
  );
  await symlink(outside, path.join(root, "dist"));

  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, root]),
    /refusing to clean a symbolic-link build output/u,
  );
});
