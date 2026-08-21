import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { providerFreeEnvironment } from "./provider-free-environment.mjs";

const execFileAsync = promisify(execFile);

test("provider-free Git resolution discards hostile ambient command and config injection", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "koni-git-environment-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const isolatedConfig = path.join(root, "isolated.gitconfig");
  await writeFile(isolatedConfig, '[protocol "https"]\n\tallow = never\n', "utf8");

  const environment = providerFreeEnvironment(
    {
      GIT_CONFIG_GLOBAL: isolatedConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    {
      PATH: process.env.PATH,
      GIT_ASKPASS: "/hostile/askpass",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "protocol.https.allow",
      GIT_CONFIG_VALUE_0: "always",
      GIT_DIR: "/hostile/repository",
      GIT_SSH_COMMAND: "hostile-ssh --steal-command",
      GIT_WORK_TREE: "/hostile/worktree",
    },
  );

  for (const name of [
    "GIT_ASKPASS",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_DIR",
    "GIT_SSH_COMMAND",
    "GIT_WORK_TREE",
  ]) {
    assert.equal(environment[name], undefined, `${name} escaped the sealed Git environment`);
  }
  assert.deepEqual(
    (
      await execFileAsync("git", ["config", "--get-all", "protocol.https.allow"], {
        env: environment,
      })
    ).stdout
      .trim()
      .split("\n"),
    ["never"],
  );
});
