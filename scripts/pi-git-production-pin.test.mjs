import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { providerFreeEnvironment } from "./provider-free-environment.mjs";
import {
  encodePiResolvedSkills,
  PI_RESOLVED_SKILLS_MARKER,
  parsePiResolvedSkills,
} from "./pi-resolver-output.mjs";
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

test("the Pi resolver output contract ignores status lines but requires its exact marker", () => {
  const paths = ["/fixture/skills/a/SKILL.md", "/fixture/skills/b/SKILL.md"];
  assert.deepEqual(parsePiResolvedSkills(`up to date\n${encodePiResolvedSkills(paths)}`), paths);
  assert.throws(() => parsePiResolvedSkills(JSON.stringify(paths)), /marker/u);
  assert.throws(
    () => parsePiResolvedSkills(`${encodePiResolvedSkills(paths)}\ntrailing`),
    /payload/u,
  );
});
const unpinnedProductionSource = "git:github.com/obra/superpowers";

test("the materialized production remote keeps the reviewed object off its decoy default", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "koni-production-pin-remote-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const environment = providerFreeEnvironment({
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  const repository = await materializePinnedSuperpowersRepository(
    path.join(root, "superpowers.git"),
    environment,
  );

  const defaultOid = await gitOutput(environment, repository, "rev-parse", "HEAD");
  const defaultTree = await gitOutput(environment, repository, "rev-parse", "HEAD^{tree}");
  assert.notEqual(defaultOid, pinnedSuperpowersFixture.commit);
  assert.notEqual(defaultTree, pinnedSuperpowersFixture.tree);
  assert.equal(
    await gitOutput(environment, repository, "symbolic-ref", "HEAD"),
    "refs/heads/decoy",
  );
  const refs = (
    await gitOutput(environment, repository, "for-each-ref", "--format=%(refname) %(objectname)")
  )
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(
    refs.filter((entry) => entry.endsWith(` ${pinnedSuperpowersFixture.commit}`)),
    [`refs/heads/pinned ${pinnedSuperpowersFixture.commit}`],
  );
  assert.equal(
    refs.some((entry) => /refs\/[^ ]*\b[a-f0-9]{40}\b/u.test(entry)),
    false,
  );
  assert.equal(
    refs.some((entry) => entry.startsWith("refs/tags/")),
    false,
  );
  assert.equal(
    await gitOutput(environment, repository, "rev-parse", "--is-shallow-repository"),
    "true",
  );
});

test("Pi resolves and reconciles the exact production Superpowers object without network", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "koni-production-pin-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const hostile = await installHostileGitAmbient(root);
  context.after(hostile.restore);
  assert.equal(
    JSON.parse(await readFile(path.join(piPackageRoot, "package.json"), "utf8")).version,
    "0.80.10",
  );

  const fixtureRepository = path.join(root, "superpowers.git");
  const config = path.join(root, "sealed.gitconfig");
  const localUrl = pathToFileURL(fixtureRepository).href;
  const environment = providerFreeEnvironment({
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    NODE_ENV: "test",
    PI_OFFLINE: undefined,
  });
  for (const name of hostile.names) {
    assert.equal(environment[name], undefined, `${name} escaped the sealed Git environment`);
  }
  for (const [key, value] of [
    [`url.${localUrl}.insteadOf`, productionUrl],
    ["protocol.file.allow", "always"],
    ["protocol.http.allow", "never"],
    ["protocol.https.allow", "never"],
    ["protocol.git.allow", "never"],
    ["protocol.ssh.allow", "never"],
  ]) {
    await execFileAsync("git", ["config", "--file", config, key, value], { env: environment });
  }
  await materializePinnedSuperpowersRepository(fixtureRepository, environment);
  const decoyOid = await gitOutput(environment, fixtureRepository, "rev-parse", "HEAD");
  const decoyTree = await gitOutput(environment, fixtureRepository, "rev-parse", "HEAD^{tree}");
  assert.notEqual(decoyOid, pinnedSuperpowersFixture.commit);
  assert.notEqual(decoyTree, pinnedSuperpowersFixture.tree);

  const controlProject = path.join(root, "control-project");
  const controlAgent = path.join(root, "control-agent");
  await Promise.all([
    mkdir(path.join(controlProject, ".pi"), { recursive: true }),
    mkdir(controlAgent, { recursive: true }),
  ]);
  await writeFile(
    path.join(controlProject, ".pi", "settings.json"),
    `${JSON.stringify({ packages: [unpinnedProductionSource] })}\n`,
  );
  const controlHelper = await writeResolverHelper(root, {
    project: controlProject,
    agent: controlAgent,
    source: unpinnedProductionSource,
    name: "resolve-unpinned.mjs",
  });
  await execFileAsync(process.execPath, [controlHelper, "resolve"], {
    cwd: controlProject,
    env: environment,
    timeout: 30_000,
  });
  const controlClone = path.join(controlProject, ".pi", "git", "github.com", "obra", "superpowers");
  assert.equal(await gitOutput(environment, controlClone, "rev-parse", "HEAD"), decoyOid);
  assert.equal(await gitOutput(environment, controlClone, "rev-parse", "HEAD^{tree}"), decoyTree);
  assert.notEqual(
    await gitOutput(environment, controlClone, "rev-parse", "HEAD"),
    pinnedSuperpowersFixture.commit,
  );

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
  const helper = await writeResolverHelper(root, {
    project,
    agent,
    source: productionSource,
    name: "resolve.mjs",
  });

  const fresh = await execFileAsync(process.execPath, [helper, "resolve"], {
    cwd: project,
    env: environment,
    timeout: 30_000,
  });
  const clone = path.join(project, ".pi", "git", "github.com", "obra", "superpowers");
  assert.deepEqual(
    parsePiResolvedSkills(fresh.stdout),
    pinnedSuperpowersFixture.skills.map((id) => path.join(clone, "skills", id, "SKILL.md")),
  );
  assert.equal(
    await gitOutput(environment, clone, "rev-parse", "HEAD"),
    pinnedSuperpowersFixture.commit,
  );
  assert.equal(
    await gitOutput(environment, clone, "rev-parse", "HEAD^{tree}"),
    pinnedSuperpowersFixture.tree,
  );
  assert.equal(
    await gitOutput(environment, clone, "rev-parse", "HEAD:skills"),
    pinnedSuperpowersFixture.skillsTree,
  );
  assert.equal(
    await gitOutput(environment, clone, "config", "--local", "--get", "remote.origin.url"),
    productionUrl,
  );
  assert.equal(await gitOutput(environment, clone, "remote", "get-url", "origin"), localUrl);
  assert.equal(
    await readFile(path.join(project, ".pi", "git", ".gitignore"), "utf8"),
    "*\n!.gitignore\n",
  );

  await writeFile(path.join(clone, "off-ref.txt"), "existing clone drift\n");
  await execFileAsync("git", ["add", "off-ref.txt"], { cwd: clone, env: environment });
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
    { cwd: clone, env: environment },
  );
  await execFileAsync(process.execPath, [helper, "update"], {
    cwd: project,
    env: environment,
    timeout: 30_000,
  });
  assert.equal(
    await gitOutput(environment, clone, "rev-parse", "HEAD"),
    pinnedSuperpowersFixture.commit,
  );
  assert.equal(
    await gitOutput(environment, clone, "rev-parse", "HEAD^{tree}"),
    pinnedSuperpowersFixture.tree,
  );
  assert.equal(
    await gitOutput(environment, clone, "rev-parse", "HEAD:skills"),
    pinnedSuperpowersFixture.skillsTree,
  );
  assert.equal(existsSync(path.join(clone, "off-ref.txt")), false);
  await assert.rejects(
    execFileAsync("git", ["clone", `${productionUrl}-fork`, path.join(root, "forbidden")], {
      env: environment,
    }),
  );
  assert.equal(existsSync(hostile.sentinel), false, "hostile Git hook or signer executed");
  assert.deepEqual(await readdir(hostile.objectDirectory), []);
});

async function writeResolverHelper(root, { project, agent, source, name }) {
  const helper = path.join(root, name);
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
  process.stdout.write(${JSON.stringify(PI_RESOLVED_SKILLS_MARKER)} + JSON.stringify(resolved.skills.map(({ path }) => path).sort()));
}
`,
  );
  return helper;
}

async function gitOutput(environment, cwd, ...args) {
  return (await execFileAsync("git", args, { cwd, env: environment })).stdout.trim();
}

async function installHostileGitAmbient(root) {
  const sentinel = path.join(root, "hostile-git-executed");
  const hooks = path.join(root, "hostile-hooks");
  const objectDirectory = path.join(root, "hostile-objects");
  await Promise.all([mkdir(hooks), mkdir(objectDirectory)]);
  const hostileProgram = path.join(hooks, "pre-commit");
  await writeFile(
    hostileProgram,
    `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(sentinel)}, "executed\\n");\nprocess.exit(91);\n`,
  );
  await chmod(hostileProgram, 0o700);
  const ambient = {
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hooks,
    GIT_CONFIG_KEY_1: "commit.gpgSign",
    GIT_CONFIG_VALUE_1: "true",
    GIT_CONFIG_KEY_2: "gpg.program",
    GIT_CONFIG_VALUE_2: hostileProgram,
    GIT_CONFIG_KEY_3: "user.signingKey",
    GIT_CONFIG_VALUE_3: "hostile-signing-key",
    GIT_OBJECT_DIRECTORY: objectDirectory,
  };
  const previous = new Map(Object.keys(ambient).map((name) => [name, process.env[name]]));
  Object.assign(process.env, ambient);
  return {
    names: Object.keys(ambient),
    objectDirectory,
    sentinel,
    restore() {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}
