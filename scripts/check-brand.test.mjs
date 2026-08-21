import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = fileURLToPath(new URL("./check-brand.sh", import.meta.url));
const forbiddenRepository = "real" + "-nigga-harness";
const legacyProduct = "pytha" + "goras";

test("brand audit disables Git paging for every grep", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "koni-brand-audit-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const invocationLog = path.join(fixtureRoot, "git-invocations");
  const fakeGit = path.join(fixtureRoot, "git");
  await writeFile(
    fakeGit,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$KONI_GIT_INVOCATION_LOG"\nexit 1\n`,
  );
  await chmod(fakeGit, 0o755);

  const { stdout } = await execFileAsync("bash", [scriptPath], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      KONI_GIT_INVOCATION_LOG: invocationLog,
      PATH: `${fixtureRoot}:${process.env.PATH ?? ""}`,
    },
  });

  assert.match(stdout, /Brand audit passed/u);
  assert.deepEqual((await readFile(invocationLog, "utf8")).trim().split("\n"), [
    `--no-pager grep -n -i -e ${forbiddenRepository} -- .`,
    `--no-pager grep -n -i -e ${legacyProduct} -- .`,
  ]);
});
