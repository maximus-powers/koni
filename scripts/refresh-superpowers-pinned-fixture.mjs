import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  materializePinnedSuperpowersRepository,
  pinnedSuperpowersFixture,
} from "./superpowers-pinned-fixture.mjs";

const execFileAsync = promisify(execFile);
const fixtureRoot = fileURLToPath(new URL("./fixtures/superpowers-b36e0829/", import.meta.url));
const manifestPath = path.join(fixtureRoot, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const refresh = process.argv.includes("--refresh");
const root = await mkdtemp(path.join(tmpdir(), "koni-superpowers-refresh-"));

try {
  if (!refresh) {
    await materializePinnedSuperpowersRepository(path.join(root, "verified.git"));
    process.stdout.write(
      `${JSON.stringify({
        commit: pinnedSuperpowersFixture.commit,
        tree: pinnedSuperpowersFixture.tree,
        skillsTree: pinnedSuperpowersFixture.skillsTree,
        packSha256: pinnedSuperpowersFixture.pack.sha256,
      })}\n`,
    );
    process.exitCode = 0;
  } else {
    const repository = path.join(root, "source");
    await execFileAsync("git", ["init", "-q", repository], { env: sealedGitEnvironment() });
    await execFileAsync(
      "git",
      [
        "-c",
        "protocol.file.allow=never",
        "-c",
        "protocol.git.allow=never",
        "-c",
        "protocol.ssh.allow=never",
        "fetch",
        "-q",
        "--depth=1",
        manifest.upstream,
        manifest.commit,
      ],
      { cwd: repository, env: sealedGitEnvironment() },
    );
    assert.equal(await gitOutput(repository, "rev-parse", "FETCH_HEAD"), manifest.commit);
    assert.equal(await gitOutput(repository, "rev-parse", "FETCH_HEAD^{tree}"), manifest.tree);
    assert.equal(
      await gitOutput(repository, "rev-parse", "FETCH_HEAD:skills"),
      manifest.skillsTree,
    );
    const skills = (await gitOutput(repository, "ls-tree", "--name-only", "FETCH_HEAD:skills"))
      .split("\n")
      .sort();
    assert.deepEqual(skills, manifest.skills);

    const objects = new Set([manifest.commit, manifest.tree]);
    for (const line of (
      await gitOutput(repository, "ls-tree", "-r", "-t", "--format=%(objectname)", "FETCH_HEAD")
    ).split("\n")) {
      if (line) objects.add(line);
    }
    assert.equal(objects.size, manifest.pack.objectCount);
    const orderedObjects = [...objects].sort().join("\n") + "\n";
    const pack = await runWithInput(
      "git",
      ["pack-objects", "--stdout", "--compression=9"],
      Buffer.from(orderedObjects),
      repository,
    );
    const sha256 = createHash("sha256").update(pack).digest("hex");
    await writeFile(path.join(fixtureRoot, manifest.pack.file), pack);
    process.stdout.write(`${JSON.stringify({ bytes: pack.length, sha256 })}\n`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

function sealedGitEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_")) delete environment[key];
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function gitOutput(cwd, ...args) {
  return (await execFileAsync("git", args, { cwd, env: sealedGitEnvironment() })).stdout.trim();
}

function runWithInput(command, args, input, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: sealedGitEnvironment(), stdio: "pipe" });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} ${args.join(" ")} failed: ${Buffer.concat(stderr)}`));
    });
    child.stdin.end(input);
  });
}
