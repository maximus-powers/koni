import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixtureRoot = fileURLToPath(new URL("./fixtures/superpowers-b36e0829/", import.meta.url));
const metadata = JSON.parse(await readFile(path.join(fixtureRoot, "manifest.json"), "utf8"));

export const pinnedSuperpowersFixture = Object.freeze(metadata);

export async function materializePinnedSuperpowersRepository(destination) {
  const packSource = path.join(fixtureRoot, metadata.pack.file);
  const packBytes = await readFile(packSource);
  assert.equal(
    createHash("sha256").update(packBytes).digest("hex"),
    metadata.pack.sha256,
    "the committed Superpowers object pack must match its reviewed manifest",
  );
  await mkdir(destination, { recursive: true });
  const environment = sealedLocalGitEnvironment();
  await execFileAsync("git", ["init", "-q", "--bare"], { cwd: destination, env: environment });
  const packDestination = path.join(destination, "objects", "pack", metadata.pack.file);
  await copyFile(packSource, packDestination);
  await execFileAsync("git", ["index-pack", packDestination], {
    cwd: destination,
    env: environment,
  });
  const indexDestination = packDestination.replace(/\.pack$/u, ".idx");
  const verification = await execFileAsync("git", ["verify-pack", "-v", indexDestination], {
    cwd: destination,
    env: environment,
  });
  assert.equal(
    verification.stdout.split("\n").filter((line) => /^[a-f0-9]{40} /u.test(line)).length,
    metadata.pack.objectCount,
    "the Superpowers pack must contain exactly the reviewed object closure",
  );
  await writeFile(path.join(destination, "shallow"), `${metadata.commit}\n`, "utf8");
  await execFileAsync("git", ["update-ref", "refs/heads/pinned", metadata.commit], {
    cwd: destination,
    env: environment,
  });
  await execFileAsync("git", ["symbolic-ref", "HEAD", "refs/heads/pinned"], {
    cwd: destination,
    env: environment,
  });
  await execFileAsync("git", ["fsck", "--full", "--no-dangling"], {
    cwd: destination,
    env: environment,
  });
  assert.equal(await gitOutput(destination, "rev-parse", "HEAD"), metadata.commit);
  assert.equal(await gitOutput(destination, "rev-parse", "--is-shallow-repository"), "true");
  assert.equal(await gitOutput(destination, "rev-parse", "HEAD^{tree}"), metadata.tree);
  assert.equal(await gitOutput(destination, "rev-parse", "HEAD:skills"), metadata.skillsTree);
  return destination;
}

async function gitOutput(cwd, ...args) {
  return (
    await execFileAsync("git", args, { cwd, env: sealedLocalGitEnvironment() })
  ).stdout.trim();
}

function sealedLocalGitEnvironment() {
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
