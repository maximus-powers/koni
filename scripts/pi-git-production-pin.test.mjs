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
import {
  materializePinnedSuperpowersRepository,
  pinnedSuperpowersFixture,
} from "./superpowers-pinned-fixture.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const piPackageRoot = path.join(
  repositoryRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);
const productionUrl = "https://github.com/obra/superpowers";
const productionSource = `git:github.com/obra/superpowers@${pinnedSuperpowersFixture.commit}`;

test("Pi resolves and reconciles the exact production Superpowers object without network", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "koni-production-pin-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(
    JSON.parse(await readFile(path.join(piPackageRoot, "package.json"), "utf8")).version,
    "0.80.10",
  );

  const fixtureRepository = await materializePinnedSuperpowersRepository(
    path.join(root, "superpowers.git"),
  );
  const config = path.join(root, "sealed.gitconfig");
  const localUrl = pathToFileURL(fixtureRepository).href;
  for (const [key, value] of [
    [`url.${localUrl}.insteadOf`, productionUrl],
    ["protocol.file.allow", "always"],
    ["protocol.http.allow", "never"],
    ["protocol.https.allow", "never"],
    ["protocol.git.allow", "never"],
    ["protocol.ssh.allow", "never"],
  ]) {
    await execFileAsync("git", ["config", "--file", config, key, value]);
  }
  const environment = providerFreeEnvironment({
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    NODE_ENV: "test",
    PI_OFFLINE: undefined,
  });
  const project = path.join(root, "project");
  const agent = path.join(root, "agent");
  await Promise.all([
    mkdir(path.join(project, ".pi"), { recursive: true }),
    mkdir(agent, { recursive: true }),
  ]);
  await writeFile(
    path.join(project, ".pi", "settings.json"),
    `${JSON.stringify({ packages: [productionSource] })}\n`,
  );
  const helper = await writeResolverHelper(root, { project, agent });

  const fresh = await execFileAsync(process.execPath, [helper, "resolve"], {
    cwd: project,
    env: environment,
    timeout: 30_000,
  });
  const clone = path.join(project, ".pi", "git", "github.com", "obra", "superpowers");
  assert.deepEqual(
    JSON.parse(fresh.stdout.slice(fresh.stdout.lastIndexOf("__KONI_SKILLS__") + 15)),
    pinnedSuperpowersFixture.skills.map((id) => path.join(clone, "skills", id, "SKILL.md")),
  );
  assert.equal(await gitOutput(clone, "rev-parse", "HEAD"), pinnedSuperpowersFixture.commit);
  assert.equal(await gitOutput(clone, "rev-parse", "HEAD^{tree}"), pinnedSuperpowersFixture.tree);
  assert.equal(
    await gitOutput(clone, "rev-parse", "HEAD:skills"),
    pinnedSuperpowersFixture.skillsTree,
  );
  assert.equal(await gitOutput(clone, "remote", "get-url", "origin"), productionUrl);
  assert.equal(
    await readFile(path.join(project, ".pi", "git", ".gitignore"), "utf8"),
    "*\n!.gitignore\n",
  );

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
      "Move existing clone off the production pin",
    ],
    { cwd: clone },
  );
  await execFileAsync(process.execPath, [helper, "update"], {
    cwd: project,
    env: environment,
    timeout: 30_000,
  });
  assert.equal(await gitOutput(clone, "rev-parse", "HEAD"), pinnedSuperpowersFixture.commit);
  assert.equal(await gitOutput(clone, "rev-parse", "HEAD^{tree}"), pinnedSuperpowersFixture.tree);
  assert.equal(
    await gitOutput(clone, "rev-parse", "HEAD:skills"),
    pinnedSuperpowersFixture.skillsTree,
  );
  assert.equal(existsSync(path.join(clone, "off-ref.txt")), false);
  await assert.rejects(
    execFileAsync("git", ["clone", `${productionUrl}-fork`, path.join(root, "forbidden")], {
      env: environment,
    }),
  );
});

async function writeResolverHelper(root, { project, agent }) {
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
const source = ${JSON.stringify(productionSource)};
const settingsManager = SettingsManager.create(project, agent, { projectTrusted: true });
const manager = new DefaultPackageManager({ cwd: project, agentDir: agent, settingsManager });
if (process.argv[2] === "update") await manager.update(source);
const resolved = await manager.resolve();
if (process.argv[2] === "resolve") {
  process.stdout.write("__KONI_SKILLS__" + JSON.stringify(resolved.skills.map(({ path }) => path).sort()));
}
`,
  );
  return helper;
}

async function gitOutput(cwd, ...args) {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}
