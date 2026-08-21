import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { providerFreeEnvironment } from "./provider-free-environment.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);
const piPackageRoot = path.join(
  repositoryRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);
const { parseGitUrl } = await import(
  pathToFileURL(path.join(piPackageRoot, "dist", "utils", "git.js")).href
);

test("Pi 0.80.10 resolves and reconciles a raw-OID Git package without network", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "koni-pi-raw-oid-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(
    JSON.parse(await readFile(path.join(piPackageRoot, "package.json"), "utf8")).version,
    "0.80.10",
  );

  const fixture = await createGitFixture(root);
  const sourceUrl = "https://localhost/koni/superpowers";
  const source = `git:${sourceUrl}@${fixture.commitOid}`;
  assert.deepEqual(parseGitUrl(source), {
    type: "git",
    repo: sourceUrl,
    host: "localhost",
    path: "koni/superpowers",
    ref: fixture.commitOid,
    pinned: true,
  });

  const project = path.join(root, "project");
  const agent = path.join(root, "agent");
  await Promise.all([
    mkdir(path.join(project, ".pi"), { recursive: true }),
    mkdir(agent, { recursive: true }),
  ]);
  await writeFile(
    path.join(project, ".pi", "settings.json"),
    `${JSON.stringify({ packages: [source] })}\n`,
  );
  const helper = await writeResolverHelper(root, { project, agent, source });
  const environment = providerFreeEnvironment({
    GIT_CONFIG_GLOBAL: fixture.config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    NODE_ENV: "test",
  });

  const fresh = await execFileAsync(process.execPath, [helper, "resolve"], {
    cwd: project,
    env: environment,
    timeout: 30_000,
  });
  const clone = path.join(project, ".pi", "git", "localhost", "koni", "superpowers");
  assert.deepEqual(JSON.parse(fresh.stdout), [
    path.join(clone, "skills", "using-superpowers", "SKILL.md"),
  ]);
  assert.equal(await gitOutput(clone, "rev-parse", "HEAD"), fixture.commitOid);
  assert.equal(await gitOutput(clone, "remote", "get-url", "origin"), sourceUrl);

  await writeFile(path.join(clone, "off-ref.txt"), "existing clone drift\n");
  await execFileAsync("git", ["add", "off-ref.txt"], { cwd: clone });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Koni resolver test",
      "-c",
      "user.email=koni-resolver@example.invalid",
      "commit",
      "-q",
      "-m",
      "Move existing clone off the configured OID",
    ],
    { cwd: clone },
  );
  assert.notEqual(await gitOutput(clone, "rev-parse", "HEAD"), fixture.commitOid);

  await execFileAsync(process.execPath, [helper, "update"], {
    cwd: project,
    env: environment,
    timeout: 30_000,
  });
  assert.equal(await gitOutput(clone, "rev-parse", "HEAD"), fixture.commitOid);
  assert.equal(await gitOutput(clone, "rev-parse", "HEAD^{tree}"), fixture.treeOid);
  assert.equal(existsSync(path.join(clone, "off-ref.txt")), false);
});

async function createGitFixture(root) {
  const repository = path.join(root, "source");
  const config = path.join(root, "sealed.gitconfig");
  const skillRoot = path.join(repository, "skills", "using-superpowers");
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    path.join(skillRoot, "SKILL.md"),
    "---\nname: using-superpowers\ndescription: Raw-OID resolver fixture.\n---\n",
  );
  await execFileAsync("git", ["init", "-q"], { cwd: repository });
  await execFileAsync("git", ["add", "skills"], { cwd: repository });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Koni resolver test",
      "-c",
      "user.email=koni-resolver@example.invalid",
      "commit",
      "-q",
      "-m",
      "Create raw-OID fixture",
    ],
    { cwd: repository },
  );
  const commitOid = await gitOutput(repository, "rev-parse", "HEAD");
  const treeOid = await gitOutput(repository, "rev-parse", "HEAD^{tree}");
  const localUrl = pathToFileURL(repository).href;
  for (const [key, value] of [
    [`url.${localUrl}.insteadOf`, "https://localhost/koni/superpowers"],
    ["protocol.file.allow", "always"],
    ["protocol.http.allow", "never"],
    ["protocol.https.allow", "never"],
    ["protocol.git.allow", "never"],
    ["protocol.ssh.allow", "never"],
  ]) {
    await execFileAsync("git", ["config", "--file", config, key, value]);
  }
  return { config, commitOid, treeOid };
}

async function writeResolverHelper(root, { project, agent, source }) {
  const helper = path.join(root, "resolve.mjs");
  const packageManagerUrl = pathToFileURL(
    path.join(piPackageRoot, "dist", "core", "package-manager.js"),
  ).href;
  const settingsManagerUrl = pathToFileURL(
    path.join(piPackageRoot, "dist", "core", "settings-manager.js"),
  ).href;
  await writeFile(
    helper,
    `
import { DefaultPackageManager } from ${JSON.stringify(packageManagerUrl)};
import { SettingsManager } from ${JSON.stringify(settingsManagerUrl)};
const project = ${JSON.stringify(project)};
const agent = ${JSON.stringify(agent)};
const source = ${JSON.stringify(source)};
const settingsManager = SettingsManager.create(project, agent, { projectTrusted: true });
const manager = new DefaultPackageManager({ cwd: project, agentDir: agent, settingsManager });
if (process.argv[2] === "update") await manager.update(source);
const resolved = await manager.resolve();
if (process.argv[2] === "resolve") {
  process.stdout.write(JSON.stringify(resolved.skills.map(({ path }) => path).sort()));
}
`,
  );
  return helper;
}

async function gitOutput(cwd, ...args) {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}
