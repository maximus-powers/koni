import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);
const stockPiVersion = "0.80.10";
const stockTypeboxVersion = "1.1.38";
const publicPackages = new Map([
  ["@koni/core", "core"],
  ["@koni/coding-profile", "coding-profile"],
  ["@koni/research-profile", "research-profile"],
]);
const bundledPeers = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

test("shipping manifests reuse Pi's bundled SDK while the development runtime stays exact", async () => {
  const root = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const manifests = await Promise.all([...publicPackages.values()].map(async (name) =>
    JSON.parse(await readFile(path.join(repositoryRoot, "packages", name, "package.json"), "utf8"))));
  assert.equal(root.devDependencies["@earendil-works/pi-coding-agent"], stockPiVersion);
  assert.equal(root.devDependencies.typebox, stockTypeboxVersion);
  assert.equal(manifests[0].bin.koni, "./bin/koni.js");
  assert.equal(manifests[0].koni.pi_range, stockPiVersion,
    "the shipping launcher must advertise the exact Pi runtime it verifies");
  for (const manifest of manifests) {
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (bundledPeers.includes(name)) {
        assert.equal(range, "*", `${manifest.name} must reuse Pi's ${name}`);
        assert.equal(manifest.peerDependenciesMeta?.[name]?.optional, true,
          `${manifest.name} must prevent npm from auto-installing Pi's host peer ${name}`);
      }
    }
  }
  assert.equal(manifests[0].peerDependencies.typebox, "*");
  assert.equal(manifests[0].dependencies?.typebox, undefined);
  await assertSourceInstallerPathHandoff();
});

async function assertSourceInstallerPathHandoff() {
  const root = await mkdtemp(path.join(tmpdir(), "koni-path-handoff-"));
  const prefix = path.join(root, "prefix");
  const shadow = path.join(root, "shadow");
  const script = path.join(repositoryRoot, "scripts", "report-koni-path.sh");
  await Promise.all([
    mkdir(path.join(prefix, "bin"), { recursive: true }),
    mkdir(shadow),
  ]);
  try {
    for (const executable of [path.join(prefix, "bin", "koni"), path.join(shadow, "koni")]) {
      await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(executable, 0o755);
    }
    const systemPath = "/usr/bin:/bin";
    const shadowed = await execFileAsync("/bin/bash", [script, prefix], {
      env: { ...process.env, PATH: `${shadow}${path.delimiter}${path.join(prefix, "bin")}${path.delimiter}${systemPath}` },
    });
    assert.match(shadowed.stdout, new RegExp(escapeRegExp(path.join(shadow, "koni")), "u"));
    assert.match(shadowed.stdout, /Prepend the activated Koni command directory/u);
    const active = await execFileAsync("/bin/bash", [script, prefix], {
      env: { ...process.env, PATH: `${path.join(prefix, "bin")}${path.delimiter}${shadow}${path.delimiter}${systemPath}` },
    });
    assert.equal(active.stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("exact tarballs run through stock Pi without a second SDK, credentials, or provider calls", {
  timeout: 180_000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "koni-stock-pi-package-smoke-"));
  const home = path.join(root, "home");
  const agent = path.join(root, "pi-agent");
  const project = path.join(root, "project");
  const cliProject = path.join(root, "cli-project");
  const stockPiRoot = path.join(root, "stock-pi");
  const ambientPackage = path.join(root, "ambient-package");
  const wrapper = path.join(root, "npm-tarball-wrapper.mjs");
  await Promise.all([
    mkdir(home),
    mkdir(agent),
    mkdir(project),
    mkdir(cliProject),
    mkdir(stockPiRoot),
    mkdir(path.join(ambientPackage, "skills", "ambient-skill"), { recursive: true }),
  ]);

  try {
    await Promise.all([
      execFileAsync("git", ["init", "-q"], { cwd: project }),
      execFileAsync("git", ["init", "-q"], { cwd: cliProject }),
    ]);
    await installStockPi(stockPiRoot);
    const piPackageRoot = path.join(stockPiRoot, "node_modules", "@earendil-works", "pi-coding-agent");
    const pi = path.join(stockPiRoot, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
    assert.equal(JSON.parse(await readFile(path.join(piPackageRoot, "package.json"), "utf8")).version, stockPiVersion);
    assert.equal(JSON.parse(await readFile(path.join(piPackageRoot, "node_modules", "typebox", "package.json"), "utf8")).version,
      stockTypeboxVersion);
    await assertLauncherDiscoveryShapes({ root, pi, piPackageRoot });

    const archives = await exactArchives(root);
    await assertOrdinaryNpmDoesNotInstallHostPeers({ root, archives, pi, home });
    await writeTarballWrapper(wrapper);
    await writeAmbientResources(agent, ambientPackage, wrapper);
    const ambientBefore = await snapshotAmbient(agent, ambientPackage);
    const piEnvironment = providerFreeEnvironment({
      HOME: home,
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      KONI_SMOKE_TARBALL_MAP: JSON.stringify(Object.fromEntries(
        [...archives].map(([name, value]) => [`${name}@${value.version}`, value.archive]),
      )),
    });

    for (const [name, value] of archives) {
      await execFileAsync(pi, ["install", `npm:${name}@${value.version}`], {
        cwd: project,
        env: piEnvironment,
      });
    }
    await assertManagedInstall(agent, archives);
    await assertVersionBundleIntegrity({ root, agent, archives });
    await assertAmbientPreserved(agent, ambientPackage, ambientBefore, archives);
    await assertAtomicRegistrarSafety({ root, stockPiRoot, agent });

    const launcher = path.join(agent, "npm", "node_modules", ".bin", process.platform === "win32" ? "koni.cmd" : "koni");
    assert.equal(existsSync(launcher), true, "Pi's one managed closure must expose the manual koni command");
    const launcherEnvironment = {
      ...piEnvironment,
      PATH: `${path.dirname(pi)}${path.delimiter}${piEnvironment.PATH ?? ""}`,
    };
    const version = await execFileAsync(launcher, ["--version"], {
      cwd: cliProject,
      env: launcherEnvironment,
    });
    assert.equal(version.stdout.trim(), archives.get("@koni/core").version);
    await execFileAsync(launcher, ["init", "coding", "--root", cliProject], {
      cwd: cliProject,
      env: launcherEnvironment,
    });
    await execFileAsync(launcher, ["config", "validate", "--root", cliProject, "--json"], {
      cwd: cliProject,
      env: launcherEnvironment,
    });

    // This crosses the eager-CLI/daemon boundary and fails if a raw child loses the user's Pi
    // peer bridge. The disposable authority is stopped in finally below.
    await execFileAsync(launcher, ["start", "--root", cliProject], {
      cwd: cliProject,
      env: launcherEnvironment,
      timeout: 20_000,
    });
    await execFileAsync(launcher, ["stop", "--root", cliProject], {
      cwd: cliProject,
      env: launcherEnvironment,
      timeout: 20_000,
    });

    await assertPackedAuthorityRace({
      coreRoot: path.join(agent, "npm", "node_modules", "@koni", "core"),
      root,
      environment: launcherEnvironment,
      version: archives.get("@koni/core").version,
    });

    const piStateBeforeSession = await snapshotTree(agent);
    await constructAndAbortAgentSession({
      stockPiRoot,
      agent,
      project,
      root,
    });
    await assertPackedProductionAttempt({
      coreRoot: path.join(agent, "npm", "node_modules", "@koni", "core"),
      project: cliProject,
      root,
      environment: launcherEnvironment,
      version: archives.get("@koni/core").version,
    });
    assert.deepEqual(await snapshotTree(agent), piStateBeforeSession,
      "provider-free AgentSession construction must not alter ambient Pi state");

    await exerciseInstalledPiResources({ pi, project, agent, environment: piEnvironment });
    await assertLegacyDuplicateCoreFailsClosed({ pi, agent, root, environment: piEnvironment });
    await assertAmbientPreserved(agent, ambientPackage, ambientBefore, archives);
  } finally {
    await stopDisposableAuthority(cliProject);
    await rm(root, { recursive: true, force: true });
  }
});

async function assertLauncherDiscoveryShapes({ root, pi, piPackageRoot }) {
  const { findPiPackageRoot, preparePiRuntime } = await import(pathToFileURL(
    path.join(repositoryRoot, "packages", "core", "bin", "koni.js"),
  ).href);
  const originalPath = process.env.PATH;
  const originalRoot = process.env.KONI_PI_PACKAGE_ROOT;
  const posixDirectory = path.join(root, "posix-wrapper");
  const windowsDirectory = path.join(root, "windows-wrapper");
  const opaqueDirectory = path.join(root, "opaque-wrapper");
  const decoyDirectory = path.join(root, "non-executable-decoy");
  const dottedRoot = path.join(root, "pi.0.80.10");
  const prereleaseRoot = path.join(root, "pi-prerelease");
  await Promise.all([
    mkdir(posixDirectory),
    mkdir(windowsDirectory),
    mkdir(opaqueDirectory),
    mkdir(decoyDirectory),
    mkdir(dottedRoot),
    mkdir(prereleaseRoot),
  ]);
  const posixWrapper = path.join(posixDirectory, "pi");
  await writeFile(posixWrapper, `#!/bin/sh\nexec "${pi}" "$@"\n`, "utf8");
  await chmod(posixWrapper, 0o755);
  await writeFile(path.join(windowsDirectory, "pi.cmd"), `@"${pi}" %*\r\n`, "utf8");
  await chmod(path.join(windowsDirectory, "pi.cmd"), 0o755);
  const opaqueWrapper = path.join(opaqueDirectory, "pi");
  await writeFile(opaqueWrapper, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(opaqueWrapper, 0o755);
  await writeFile(path.join(decoyDirectory, "pi"), "not executable\n", { encoding: "utf8", mode: 0o644 });
  await writeFile(path.join(dottedRoot, "package.json"), `${JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    version: stockPiVersion,
  })}\n`, "utf8");
  await writeFile(path.join(prereleaseRoot, "package.json"), `${JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    version: `${stockPiVersion}-beta.1`,
  })}\n`, "utf8");
  try {
    delete process.env.KONI_PI_PACKAGE_ROOT;
    process.env.PATH = posixDirectory;
    const canonicalPiRoot = await realpath(piPackageRoot);
    assert.equal(findPiPackageRoot(), canonicalPiRoot, "regular POSIX wrappers must resolve their real Pi runtime");
    process.env.PATH = windowsDirectory;
    assert.equal(findPiPackageRoot(), canonicalPiRoot, "regular Windows cmd shims must resolve their real Pi runtime");
    process.env.PATH = `${decoyDirectory}${path.delimiter}${posixDirectory}`;
    assert.equal(findPiPackageRoot(), canonicalPiRoot,
      "a non-executable PATH decoy must not shadow the Pi executable the shell would run");
    process.env.PATH = `${opaqueDirectory}${path.delimiter}${path.dirname(pi)}`;
    assert.throws(() => findPiPackageRoot(), /active Pi wrapper .* is opaque/u,
      "an opaque first PATH Pi must fail closed instead of selecting a different later runtime");
    process.env.KONI_PI_PACKAGE_ROOT = dottedRoot;
    process.env.PATH = "";
    assert.equal(findPiPackageRoot(), dottedRoot, "explicit valid package roots may contain dots");
    process.env.KONI_PI_PACKAGE_ROOT = prereleaseRoot;
    await assert.rejects(preparePiRuntime(), /active Pi runtime must be 0\.80\.10/u,
      "a prerelease or build variant must not satisfy the exact tested Pi contract");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalRoot === undefined) delete process.env.KONI_PI_PACKAGE_ROOT;
    else process.env.KONI_PI_PACKAGE_ROOT = originalRoot;
  }
}

async function assertOrdinaryNpmDoesNotInstallHostPeers({ root, archives, pi, home }) {
  const prefix = path.join(root, "global-prefix");
  await mkdir(prefix);
  await execFileAsync("npm", [
    "install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", "--ignore-scripts",
    ...[...archives.values()].map((value) => value.archive),
  ]);
  const { stdout } = await execFileAsync("npm", ["root", "--global", "--prefix", prefix]);
  const globalRoot = stdout.trim();
  for (const peer of bundledPeers) {
    assert.equal(existsSync(path.join(globalRoot, ...peer.split("/"))), false,
      `ordinary npm must not auto-install optional Pi host peer ${peer}`);
  }
  const executable = path.join(prefix, "bin", process.platform === "win32" ? "koni.cmd" : "koni");
  const result = await execFileAsync(executable, ["--version"], {
    env: providerFreeEnvironment({
      HOME: home,
      PATH: `${path.dirname(pi)}${path.delimiter}${process.env.PATH ?? ""}`,
    }),
  });
  assert.equal(result.stdout.trim(), archives.get("@koni/core").version);
}

async function installStockPi(stockPiRoot) {
  await writeFile(path.join(stockPiRoot, "package.json"), `${JSON.stringify({ private: true })}\n`, "utf8");
  await execFileAsync("npm", [
    "install",
    "--prefix", stockPiRoot,
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    `@earendil-works/pi-coding-agent@${stockPiVersion}`,
  ], { cwd: stockPiRoot });
}

async function exactArchives(root) {
  const configured = process.env.KONI_PACKAGE_ARCHIVES_DIR;
  const archiveDirectory = configured === undefined ? path.join(root, "archives") : path.resolve(configured);
  if (configured === undefined) {
    await mkdir(archiveDirectory);
    for (const workspace of publicPackages.keys()) {
      await execFileAsync("npm", [
        "pack", "--workspace", workspace, "--pack-destination", archiveDirectory,
      ], { cwd: repositoryRoot });
    }
  }
  const files = (await readdir(archiveDirectory)).filter((entry) => entry.endsWith(".tgz")).sort();
  assert.equal(files.length, 3, "the smoke requires exactly the three release tarballs");
  const result = new Map();
  for (const file of files) {
    const archive = path.join(archiveDirectory, file);
    const { stdout } = await execFileAsync("tar", ["-xOf", archive, "package/package.json"]);
    const manifest = JSON.parse(stdout);
    assert.equal(publicPackages.has(manifest.name), true, `unexpected release archive ${manifest.name}`);
    result.set(manifest.name, { archive, version: manifest.version });
  }
  assert.deepEqual([...result.keys()].sort(), [...publicPackages.keys()].sort());
  return result;
}

async function writeTarballWrapper(wrapper) {
  await writeFile(wrapper, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const mapping = JSON.parse(process.env.KONI_SMOKE_TARBALL_MAP ?? "{}");
const args = process.argv.slice(2).map((value) => mapping[value] ?? value);
const result = spawnSync("npm", args, { env: process.env, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`, "utf8");
  await chmod(wrapper, 0o755);
}

async function writeAmbientResources(agent, ambientPackage, wrapper) {
  await writeFile(path.join(ambientPackage, "package.json"), `${JSON.stringify({
    name: "ambient-pi-package",
    version: "1.0.0",
    pi: { skills: ["./skills"] },
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(ambientPackage, "skills", "ambient-skill", "SKILL.md"), `---
name: ambient-skill
description: Disposable ambient Pi resource used by Koni's package-preservation smoke.
---
Ambient skill body.
`, "utf8");
  await writeFile(path.join(agent, "ambient-prompt.md"), "Ambient prompt.\n", "utf8");
  await writeFile(path.join(agent, "auth.json"), `${JSON.stringify({
    "koni-smoke-fixture": { type: "api_key", key: "not-a-real-credential" },
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(path.join(agent, "settings.json"), `${JSON.stringify({
    quietStartup: true,
    enableAnalytics: false,
    npmCommand: [process.execPath, wrapper],
    packages: [ambientPackage],
    prompts: [path.join(agent, "ambient-prompt.md")],
  }, null, 2)}\n`, "utf8");
}

async function assertManagedInstall(agent, archives) {
  const managedRoot = path.join(agent, "npm", "node_modules");
  for (const peer of bundledPeers) {
    assert.equal(existsSync(path.join(managedRoot, ...peer.split("/"))), false,
      `Pi-managed Koni packages must not install a second ${peer}`);
  }
  const allPaths = await listRelativePaths(path.join(agent, "npm"));
  for (const peer of bundledPeers) {
    const marker = `/node_modules/${peer}/`;
    assert.equal(allPaths.some((entry) => `/${entry}/`.includes(marker)), false,
      `nested ${peer} copy detected in Koni's managed package closure`);
  }
  for (const [name, value] of archives) {
    const manifest = JSON.parse(await readFile(path.join(managedRoot, ...name.split("/"), "package.json"), "utf8"));
    assert.equal(manifest.version, value.version);
  }
}

async function assertVersionBundleIntegrity({ root, agent, archives }) {
  const bundleTool = path.join(repositoryRoot, "scripts", "dev-package-bundle.mjs");
  const valid = path.join(root, "sealed-package-root");
  await cp(path.join(agent, "npm"), valid, { recursive: true, dereference: false });
  await rm(path.join(valid, "node_modules", ".bin"), { recursive: true, force: true });
  const bundleId = createHash("sha256");
  for (const { archive } of [...archives.values()].sort((left, right) => left.archive.localeCompare(right.archive))) {
    bundleId.update(await readFile(archive));
  }
  const digest = bundleId.digest("hex");
  await execFileAsync(process.execPath, [bundleTool, "seal", valid, digest]);
  await execFileAsync(process.execPath, [bundleTool, "verify", valid, digest]);

  const partial = path.join(root, "partial-package-root");
  await mkdir(partial);
  await assert.rejects(execFileAsync(process.execPath, [bundleTool, "verify", partial, digest]));

  const poisoned = path.join(root, "poisoned-package-root");
  await symlink(valid, poisoned);
  await assert.rejects(execFileAsync(process.execPath, [bundleTool, "verify", poisoned, digest]));

  const coreManifest = path.join(valid, "node_modules", "@koni", "core", "package.json");
  await writeFile(coreManifest, `${await readFile(coreManifest, "utf8")} `, "utf8");
  await assert.rejects(execFileAsync(process.execPath, [bundleTool, "verify", valid, digest]),
    "an authenticated existing root must reject post-seal content changes");
}

async function assertAtomicRegistrarSafety({ root, stockPiRoot, agent }) {
  const registrarAgent = path.join(root, "registrar-agent");
  const registrarProject = path.join(root, "registrar-project");
  const malformedAgent = path.join(root, "malformed-agent");
  const unwritableAgent = path.join(root, "unwritable-agent");
  await Promise.all([
    mkdir(registrarAgent),
    mkdir(path.join(registrarProject, ".pi"), { recursive: true }),
    mkdir(malformedAgent),
    mkdir(unwritableAgent),
  ]);
  const globalAmbient = path.join(root, "global-ambient");
  const projectAmbient = path.join(root, "project-ambient");
  const legacySettingsCredential = "not-a-real-legacy-settings-key";
  const globalSettings = {
    quietStartup: true,
    apiKeys: { "legacy-fixture-provider": legacySettingsCredential },
    packages: [globalAmbient],
  };
  const projectSettings = { packages: [projectAmbient] };
  await writeFile(path.join(registrarAgent, "settings.json"), `${JSON.stringify(globalSettings, null, 2)}\n`);
  const registrarAuthPath = path.join(registrarAgent, "auth.json");
  const registrarAuthBytes = `${JSON.stringify({
    "fixture-provider": { type: "api_key", key: "not-a-real-registrar-credential" },
  }, null, 2)}\n`;
  await writeFile(registrarAuthPath, registrarAuthBytes, { encoding: "utf8", mode: 0o600 });
  await writeFile(path.join(registrarProject, ".pi", "settings.json"), `${JSON.stringify(projectSettings, null, 2)}\n`);
  const roots = [...publicPackages.keys()].map((name) =>
    path.join(agent, "npm", "node_modules", ...name.split("/")));
  const registrar = path.join(repositoryRoot, "scripts", "register-dev-packages.mjs");
  const registrarBin = path.join(root, "registrar-bin");
  const launcher = path.join(registrarBin, "koni");
  const launcherTarget = path.join(roots[0], "bin", "koni.js");
  const journal = path.join(root, "registrar-activation.json");
  await mkdir(registrarBin);
  const environment = providerFreeEnvironment({
    HOME: path.join(root, "registrar-home"),
    PI_CODING_AGENT_DIR: registrarAgent,
    PATH: `${path.join(stockPiRoot, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  const initialSettingsBytes = await readFile(path.join(registrarAgent, "settings.json"), "utf8");
  await assert.rejects(execFileAsync(process.execPath, [
    registrar, "activate", journal, launcher, launcherTarget, ...roots,
  ], {
    cwd: registrarProject,
    env: {
      ...environment,
      NODE_ENV: "test",
      KONI_TEST_CRASH_AFTER_FSYNC: "journal",
    },
  }));
  assert.equal(existsSync(journal), false, "a killed journal publish must expose no partial final journal");
  assert.equal(await readFile(path.join(registrarAgent, "settings.json"), "utf8"), initialSettingsBytes);
  assert.equal(await readFile(registrarAuthPath, "utf8"), registrarAuthBytes);
  await execFileAsync(process.execPath, [registrar, "activate", journal, launcher, launcherTarget, ...roots], {
    cwd: registrarProject,
    env: environment,
  });
  const activationJournal = await readFile(journal, "utf8");
  assert.equal(activationJournal.includes(legacySettingsCredential), false,
    "the activation journal must never copy legacy settings credentials");
  assert.equal(activationJournal.includes("apiKeys"), false,
    "the activation journal must contain identities and Koni package entries, not full settings");
  assert.equal(activationJournal.includes(Buffer.from(legacySettingsCredential).toString("base64")), false);
  await fsSymlink(launcherTarget, launcher);
  await execFileAsync(process.execPath, [registrar, "commit", journal, launcher], {
    cwd: registrarProject,
    env: environment,
  });
  const globalAfter = JSON.parse(await readFile(path.join(registrarAgent, "settings.json"), "utf8"));
  const projectAfter = JSON.parse(await readFile(path.join(registrarProject, ".pi", "settings.json"), "utf8"));
  assert.equal(globalAfter.quietStartup, true);
  assert.deepEqual(globalAfter.apiKeys, globalSettings.apiKeys);
  assert.deepEqual(globalAfter.packages, [globalAmbient, ...roots]);
  assert.deepEqual(projectAfter, projectSettings, "project-local packages must never leak into global settings");
  assert.equal(await readFile(registrarAuthPath, "utf8"), registrarAuthBytes);
  assert.equal((await stat(registrarAuthPath)).mode & 0o777, 0o600);

  const priorKoni = "npm:@koni/core@0.9.0";
  const oldLauncherTarget = path.join(root, "old-koni-launcher");
  await writeFile(path.join(registrarAgent, "settings.json"), `${JSON.stringify({
    ...globalSettings,
    packages: [globalAmbient, priorKoni],
  }, null, 2)}\n`);
  await writeFile(oldLauncherTarget, "old launcher\n");
  await rm(launcher, { force: true });
  await symlink(oldLauncherTarget, launcher);
  const crashSettingsBytes = await readFile(path.join(registrarAgent, "settings.json"), "utf8");
  const settingsCrashJournal = path.join(root, "settings-crash-activation.json");
  await assert.rejects(execFileAsync(process.execPath, [
    registrar, "activate", settingsCrashJournal, launcher, launcherTarget, ...roots,
  ], {
    cwd: registrarProject,
    env: {
      ...environment,
      NODE_ENV: "test",
      KONI_TEST_CRASH_AFTER_FSYNC: "settings",
    },
  }));
  assert.equal(existsSync(settingsCrashJournal), true,
    "the durable journal must precede a settings publication attempt");
  assert.equal(await readFile(path.join(registrarAgent, "settings.json"), "utf8"), crashSettingsBytes,
    "a killed settings writer must leave the prior live file byte-exact");
  assert.equal(await readFile(registrarAuthPath, "utf8"), registrarAuthBytes);
  await execFileAsync(process.execPath, [registrar, "rollback", settingsCrashJournal, launcher], {
    cwd: registrarProject,
    env: environment,
    timeout: 20_000,
  });
  assert.equal(await readFile(path.join(registrarAgent, "settings.json"), "utf8"), crashSettingsBytes,
    "pre-publication rollback must not normalize or reorder untouched settings");
  assert.equal(await readlink(launcher), oldLauncherTarget);

  const rollbackJournal = path.join(root, "rollback-activation.json");
  await execFileAsync(process.execPath, [
    registrar, "activate", rollbackJournal, launcher, launcherTarget, ...roots,
  ], { cwd: registrarProject, env: environment });
  await rm(launcher, { force: true });
  await symlink(launcherTarget, launcher);
  await assert.rejects(execFileAsync(process.execPath, [
    registrar, "rollback", rollbackJournal, launcher,
  ], {
    cwd: registrarProject,
    env: {
      ...environment,
      NODE_ENV: "test",
      KONI_TEST_CRASH_AFTER_SETTINGS_ROLLBACK: "1",
    },
  }));
  const settingsAfterKilledRollback = JSON.parse(await readFile(path.join(registrarAgent, "settings.json"), "utf8"));
  assert.deepEqual(settingsAfterKilledRollback.packages, [globalAmbient, priorKoni]);
  assert.equal(await readlink(launcher), launcherTarget,
    "the crash fixture must stop between settings rollback and launcher restoration");
  assert.equal(existsSync(rollbackJournal), true);
  await execFileAsync(process.execPath, [registrar, "rollback", rollbackJournal, launcher], {
    cwd: registrarProject,
    env: environment,
    timeout: 20_000,
  });
  const rolledBack = JSON.parse(await readFile(path.join(registrarAgent, "settings.json"), "utf8"));
  assert.deepEqual(rolledBack.packages, [globalAmbient, priorKoni]);
  assert.equal(await readlink(launcher), oldLauncherTarget,
    "failed activation must restore the prior launcher atomically");

  const corruptRollbackBefore = await readFile(path.join(registrarAgent, "settings.json"), "utf8");
  const corruptRollbackJournal = path.join(root, "corrupt-settings-rollback.json");
  await execFileAsync(process.execPath, [
    registrar, "activate", corruptRollbackJournal, launcher, launcherTarget, ...roots,
  ], { cwd: registrarProject, env: environment });
  await rm(launcher, { force: true });
  await symlink(launcherTarget, launcher);
  await writeFile(path.join(registrarAgent, "settings.json"), "{ interrupted external Pi write\n", "utf8");
  await assert.rejects(execFileAsync(process.execPath, [
    registrar, "rollback", corruptRollbackJournal, launcher,
  ], { cwd: registrarProject, env: environment }));
  assert.equal(existsSync(corruptRollbackJournal), true,
    "ambiguous malformed settings must keep the recovery journal and launcher snapshot");
  assert.equal(await readlink(launcher), launcherTarget);
  assert.equal(await readFile(registrarAuthPath, "utf8"), registrarAuthBytes);
  await writeFile(path.join(registrarAgent, "settings.json"), corruptRollbackBefore, "utf8");
  await execFileAsync(process.execPath, [
    registrar, "rollback", corruptRollbackJournal, launcher,
  ], { cwd: registrarProject, env: environment });
  assert.equal(await readlink(launcher), oldLauncherTarget);

  const overlapJournal = path.join(root, "overlap-activation.json");
  let activationSettled = false;
  const overlapActivation = execFileAsync(process.execPath, [
    registrar, "activate", overlapJournal, launcher, launcherTarget, ...roots,
  ], {
    cwd: registrarProject,
    env: {
      ...environment,
      NODE_ENV: "test",
      KONI_TEST_PAUSE_AFTER_JOURNAL_MS: "500",
    },
  }).finally(() => { activationSettled = true; });
  await waitForExists(overlapJournal);
  assert.equal(activationSettled, false, "the overlap writer must begin while activation holds Pi's settings lock");
  const raceSource = "npm:@koni/core@newer-overlapping-source";
  const sdkURL = pathToFileURL(path.join(
    stockPiRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js",
  )).href;
  const overlappingWriter = `
import { SettingsManager } from ${JSON.stringify(sdkURL)};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (let attempt = 0; attempt < 50; attempt += 1) {
  const settings = SettingsManager.create(${JSON.stringify(registrarProject)}, ${JSON.stringify(registrarAgent)}, { projectTrusted: false });
  if (settings.drainErrors().length > 0) { await sleep(20); continue; }
  const current = settings.getGlobalSettings().packages ?? [];
  settings.setPackages([...current, ${JSON.stringify(raceSource)}]);
  await settings.flush();
  if (settings.drainErrors().length === 0) process.exit(0);
  await sleep(20);
}
throw new Error("overlapping Pi settings writer never acquired the shared proper-lock");
`;
  const overlapWriterPromise = execFileAsync(process.execPath, ["--input-type=module", "--eval", overlappingWriter], {
    cwd: registrarProject,
    env: environment,
    timeout: 20_000,
  });
  await overlapActivation;
  await overlapWriterPromise;
  const overlapSettings = JSON.parse(await readFile(path.join(registrarAgent, "settings.json"), "utf8"));
  assert.ok(overlapSettings.packages.includes(raceSource),
    "the concurrent Pi writer must run after, never be overwritten inside, Koni's activation transaction");
  await assert.rejects(execFileAsync(process.execPath, [
    registrar, "rollback", overlapJournal, launcher,
  ], { cwd: registrarProject, env: environment }));
  overlapSettings.packages = overlapSettings.packages.filter((entry) => entry !== raceSource);
  await writeFile(path.join(registrarAgent, "settings.json"), `${JSON.stringify(overlapSettings, null, 2)}`);
  await execFileAsync(process.execPath, [
    registrar, "rollback", overlapJournal, launcher,
  ], { cwd: registrarProject, env: environment });

  const commitConflictJournal = path.join(root, "commit-conflict-activation.json");
  await execFileAsync(process.execPath, [
    registrar, "activate", commitConflictJournal, launcher, launcherTarget, ...roots,
  ], { cwd: registrarProject, env: environment });
  const activatedSettingsBytes = await readFile(path.join(registrarAgent, "settings.json"), "utf8");
  const settingsWithNewerCore = JSON.parse(activatedSettingsBytes);
  settingsWithNewerCore.packages.push("npm:@koni/core@newer-concurrent-source");
  await writeFile(path.join(registrarAgent, "settings.json"), `${JSON.stringify(settingsWithNewerCore, null, 2)}\n`);
  await rm(launcher, { force: true });
  await symlink(launcherTarget, launcher);
  await assert.rejects(execFileAsync(process.execPath, [
    registrar, "commit", commitConflictJournal, launcher,
  ], { cwd: registrarProject, env: environment }));
  assert.equal(existsSync(commitConflictJournal), true,
    "commit must retain recovery authority when a newer Koni source wins the settings CAS");
  assert.ok(JSON.parse(await readFile(path.join(registrarAgent, "settings.json"), "utf8"))
    .packages.includes("npm:@koni/core@newer-concurrent-source"));
  await writeFile(path.join(registrarAgent, "settings.json"), activatedSettingsBytes, "utf8");
  await execFileAsync(process.execPath, [
    registrar, "rollback", commitConflictJournal, launcher,
  ], { cwd: registrarProject, env: environment });
  assert.equal(await readlink(launcher), oldLauncherTarget);

  const regularLauncher = path.join(registrarBin, "koni-regular");
  const regularBytes = "#!/bin/sh\necho previous-koni\n";
  await writeFile(regularLauncher, regularBytes, { encoding: "utf8", mode: 0o751 });
  const regularJournal = path.join(root, "regular-activation.json");
  await execFileAsync(process.execPath, [
    registrar, "activate", regularJournal, regularLauncher, launcherTarget, ...roots,
  ], { cwd: registrarProject, env: environment });
  await rm(regularLauncher, { force: true });
  await symlink(launcherTarget, regularLauncher);
  await execFileAsync(process.execPath, [registrar, "rollback", regularJournal, regularLauncher], {
    cwd: registrarProject,
    env: environment,
  });
  assert.equal(await readFile(regularLauncher, "utf8"), regularBytes);
  assert.equal((await stat(regularLauncher)).mode & 0o777, 0o751);
  assert.equal(existsSync(regularJournal), false);
  assert.equal(existsSync(`${regularJournal}.launcher-backup`), false);

  const impossibleJournal = path.join(root, "missing-backup-activation.json");
  await rm(regularLauncher, { force: true });
  await writeFile(regularLauncher, regularBytes, { encoding: "utf8", mode: 0o751 });
  await execFileAsync(process.execPath, [
    registrar, "activate", impossibleJournal, regularLauncher, launcherTarget, ...roots,
  ], { cwd: registrarProject, env: environment });
  await rm(regularLauncher, { force: true });
  await symlink(launcherTarget, regularLauncher);
  await rm(`${impossibleJournal}.launcher-backup`, { force: true });
  const settingsBeforeImpossibleRollback = await readFile(path.join(registrarAgent, "settings.json"), "utf8");
  await assert.rejects(execFileAsync(process.execPath, [
    registrar, "rollback", impossibleJournal, regularLauncher,
  ], { cwd: registrarProject, env: environment }));
  assert.equal(await readFile(path.join(registrarAgent, "settings.json"), "utf8"), settingsBeforeImpossibleRollback,
    "an unauthenticated rollback snapshot must fail before partially restoring settings");
  assert.equal(await readlink(regularLauncher), launcherTarget);
  assert.equal(existsSync(impossibleJournal), true, "unrecoverable legacy journal must remain for explicit remediation");
  await rm(impossibleJournal, { force: true });

  const orphanJournal = path.join(root, "orphan-activation.json");
  await writeFile(`${orphanJournal}.launcher-backup`, "orphaned by a pre-journal crash\n");
  await execFileAsync(process.execPath, [
    registrar, "activate", orphanJournal, regularLauncher, launcherTarget, ...roots,
  ], { cwd: registrarProject, env: environment });
  await execFileAsync(process.execPath, [registrar, "rollback", orphanJournal, regularLauncher], {
    cwd: registrarProject,
    env: environment,
  });
  assert.equal(existsSync(`${orphanJournal}.launcher-backup`), false,
    "a pre-journal crash orphan must not block the next activation");

  const malformed = "{ definitely not valid JSON\n";
  await writeFile(path.join(malformedAgent, "settings.json"), malformed);
  await assert.rejects(execFileAsync(process.execPath, [
    registrar, "activate", path.join(root, "malformed-journal.json"), launcher,
    launcherTarget, ...roots,
  ], {
    cwd: registrarProject,
    env: { ...environment, PI_CODING_AGENT_DIR: malformedAgent },
  }));
  assert.equal(await readFile(path.join(malformedAgent, "settings.json"), "utf8"), malformed,
    "malformed Pi settings must fail closed without replacement");

  if (process.platform !== "win32") {
    await writeFile(path.join(unwritableAgent, "settings.json"), `${JSON.stringify(globalSettings)}\n`);
    await chmod(unwritableAgent, 0o500);
    try {
      await assert.rejects(execFileAsync(process.execPath, [
        registrar, "activate", path.join(root, "unwritable-journal.json"), launcher,
        launcherTarget, ...roots,
      ], {
        cwd: registrarProject,
        env: { ...environment, PI_CODING_AGENT_DIR: unwritableAgent },
      }));
    } finally {
      await chmod(unwritableAgent, 0o700);
    }
    assert.deepEqual(JSON.parse(await readFile(path.join(unwritableAgent, "settings.json"), "utf8")), globalSettings,
      "unwritable Pi settings must remain unchanged");
  }

  const absentLauncher = path.join(registrarBin, "koni-absent-before-activation");
  const absentJournal = path.join(root, "absent-settings-activation.json");
  await rm(path.join(registrarAgent, "settings.json"), { force: true });
  await execFileAsync(process.execPath, [
    registrar, "activate", absentJournal, absentLauncher, launcherTarget, ...roots,
  ], { cwd: registrarProject, env: environment });
  assert.equal(existsSync(path.join(registrarAgent, "settings.json")), true);
  await execFileAsync(process.execPath, [
    registrar, "rollback", absentJournal, absentLauncher,
  ], { cwd: registrarProject, env: environment });
  assert.equal(existsSync(path.join(registrarAgent, "settings.json")), false,
    "rollback must restore an originally absent settings file rather than materializing packages: []");
  assert.equal(existsSync(absentLauncher), false);
  assert.equal(await readFile(registrarAuthPath, "utf8"), registrarAuthBytes);
}

async function fsSymlink(target, link) {
  await symlink(target, link);
}

async function assertPackedAuthorityRace({ coreRoot, root, environment, version }) {
  const project = path.join(root, "packed-authority-race");
  const helper = path.join(root, "packed-authority-race.mjs");
  await mkdir(project);
  await execFileAsync("git", ["init", "-q"], { cwd: project });
  const launcherURL = pathToFileURL(path.join(coreRoot, "bin", "koni.js")).href;
  const endpointURL = pathToFileURL(path.join(coreRoot, "dist", "authority", "endpoint.js")).href;
  const serverURL = pathToFileURL(path.join(coreRoot, "dist", "authority", "server.js")).href;
  const clientURL = pathToFileURL(path.join(coreRoot, "dist", "authority", "client.js")).href;
  const buildSha256 = `sha256:${"c".repeat(64)}`;
  await writeFile(helper, `
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { preparePiRuntime } from ${JSON.stringify(launcherURL)};

await preparePiRuntime();
const projectRoot = ${JSON.stringify(project)};
const mode = process.argv[2];
const buildSha256 = ${JSON.stringify(buildSha256)};
if (mode === "setup") {
  const { discoverAuthorityEndpoint } = await import(${JSON.stringify(endpointURL)});
  const endpoint = await discoverAuthorityEndpoint(projectRoot);
  const deadPid = 2147483647;
  await mkdir(path.dirname(endpoint.leasePath), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(endpoint.endpoint), { recursive: true, mode: 0o700 });
  await rm(endpoint.endpoint, { force: true });
  await writeFile(endpoint.leasePath, JSON.stringify({
    protocol: "koni.authority-lease.v1",
    pid: deadPid,
    nonce: "packed-stale-main-lease",
    endpoint: endpoint.endpoint,
    commonDirectory: endpoint.identity.commonDirectory,
    startedAt: "2000-01-01T00:00:00.000Z",
  }) + "\\n", { mode: 0o600 });
  const startupPath = endpoint.leasePath + ".startup-lock";
  await mkdir(startupPath, { mode: 0o700 });
  await writeFile(path.join(startupPath, "owner.json"), JSON.stringify({
    protocol: "koni.authority-startup-lock.v1",
    pid: deadPid,
    nonce: "packed-stale-startup-lock",
    createdAt: "2000-01-01T00:00:00.000Z",
  }) + "\\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify(endpoint) + "\\n");
} else if (mode === "serve") {
  const { AuthorityServer } = await import(${JSON.stringify(serverURL)});
  const server = new AuthorityServer({
    projectRoot,
    version: ${JSON.stringify(version)},
    buildSha256,
  });
  try {
    const endpoint = await server.start();
    process.stdout.write(JSON.stringify({ status: "winner", pid: process.pid, endpoint: endpoint.endpoint }) + "\\n");
    await new Promise((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
    await server.stop();
  } catch (error) {
    process.stdout.write(JSON.stringify({
      status: "loser",
      pid: process.pid,
      code: error?.code ?? "unknown",
      message: error instanceof Error ? error.message : String(error),
    }) + "\\n");
    process.exitCode = error?.code === "authority_running" ? 23 : 1;
  }
} else if (mode === "ping") {
  const { AuthorityClient } = await import(${JSON.stringify(clientURL)});
  const client = await AuthorityClient.connect({
    projectRoot,
    client: "cli",
    version: ${JSON.stringify(version)},
    buildSha256,
  });
  try {
    const response = await client.request("authority.ping");
    process.stdout.write(JSON.stringify(response.result) + "\\n");
  } finally {
    client.close();
  }
} else {
  throw new Error("unknown packed authority race mode");
}
`);
  const setup = await execFileAsync(process.execPath, [helper, "setup"], {
    cwd: project,
    env: environment,
    timeout: 10_000,
  });
  const endpoint = JSON.parse(setup.stdout.trim());
  const racers = [0, 1].map(() => spawn(process.execPath, [helper, "serve"], {
    cwd: project,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  }));
  try {
    const results = await Promise.all(racers.map((child) => firstJsonLine(child, 10_000)));
    const winners = results.filter((result) => result.status === "winner");
    const losers = results.filter((result) => result.status === "loser");
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.equal(losers.length, 1, JSON.stringify(results));
    assert.equal(losers[0].code, "authority_running");
    const winnerIndex = results.findIndex((result) => result.status === "winner");
    const loserIndex = 1 - winnerIndex;
    assert.equal(winners[0].endpoint, endpoint.endpoint);
    assert.equal(JSON.parse(await readFile(endpoint.leasePath, "utf8")).pid, winners[0].pid,
      "the surviving lease must belong to the packed winner");
    assert.equal(await waitForChildExit(racers[loserIndex], 10_000), 23,
      "the packed loser must exit with the bounded authority_running status");
    assert.equal(existsSync(endpoint.leasePath), true,
      "the losing starter must not unlink the winner's authority lease");
    assert.equal(existsSync(endpoint.endpoint), true,
      "the losing starter must not unlink the winner's listener");
    const ping = await execFileAsync(process.execPath, [helper, "ping"], {
      cwd: project,
      env: environment,
      timeout: 10_000,
    });
    assert.equal(JSON.parse(ping.stdout).version, version,
      "an installed-Core client must reach the surviving packed authority");
    racers[winnerIndex].kill("SIGTERM");
    assert.equal(await waitForChildExit(racers[winnerIndex], 10_000), 0);
  } finally {
    for (const child of racers) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await Promise.all(racers.map((child) => child.exitCode === null
      ? waitForChildExit(child, 5_000).catch(() => undefined)
      : undefined));
  }
}

async function assertPackedProductionAttempt({ coreRoot, project, root, environment, version }) {
  await execFileAsync("git", ["add", "-A"], { cwd: project });
  await execFileAsync("git", [
    "-c", "user.name=Koni package smoke",
    "-c", "user.email=koni-smoke@example.invalid",
    "commit", "-q", "-m", "Initialize packed Koni probe",
  ], { cwd: project });
  await execFileAsync("git", ["branch", "-M", "main"], { cwd: project });

  const helper = path.join(root, "packed-production-attempt-probe.mjs");
  const launcherURL = pathToFileURL(path.join(coreRoot, "bin", "koni.js")).href;
  const coreURL = pathToFileURL(path.join(coreRoot, "dist", "index.js")).href;
  await writeFile(helper, `
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { preparePiRuntime } from ${JSON.stringify(launcherURL)};

await preparePiRuntime();
const {
  AuthorityClient,
  KONI_CORE_API_VERSION,
  serveProjectAuthority,
} = await import(${JSON.stringify(coreURL)});
assert.equal(KONI_CORE_API_VERSION, ${JSON.stringify(version)});

let requestShutdown;
const shutdown = new Promise((resolve) => { requestShutdown = resolve; });
let serveFailure;
const serving = serveProjectAuthority({
  projectRoot: ${JSON.stringify(project)},
  version: KONI_CORE_API_VERSION,
  shutdown,
  providerFreeAdmissionProbe: true,
}).catch((error) => { serveFailure = error; throw error; });
let client;
try {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (serveFailure) throw serveFailure;
    try {
      client = await AuthorityClient.connect({
        projectRoot: ${JSON.stringify(project)},
        client: "cli",
        version: KONI_CORE_API_VERSION,
        connectTimeoutMs: 250,
      });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.ok(client, "packed authority never became reachable");
  const created = await client.request("run.create", {
    objective: "Prove the packed production attempt boundary without provider work",
    runTypeId: "small",
    targetRef: "refs/heads/main",
    intake: { goal: "Prove the packed production attempt boundary without provider work" },
  }, {
    expectedRevision: client.revision,
    idempotencyKey: "packed-provider-free-attempt-create",
  });
  const runId = created.result.runId;
  let run;
  let planning;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    run = (await client.request("run.get", { runId })).result;
    planning = Object.values(run.attempts).find((candidate) =>
      candidate.kind === "planning" && typeof candidate.sessionFile === "string");
    if (planning) break;
    if (run.lifecycle.phase === "blocked") throw new Error(run.lifecycle.blocker ?? "packed run blocked");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(planning, "production attempt child never durably published its Pi session file");
  assert.equal(existsSync(planning.sessionFile), true);
  assert.match(planning.launchSpecHash, /^sha256:[a-f0-9]{64}$/u);
  const lines = (await readFile(planning.sessionFile, "utf8"))
    .trimEnd().split("\\n").filter(Boolean).map((line) => JSON.parse(line));
  const header = lines.find((entry) => entry.type === "session");
  const mapping = lines.find((entry) =>
    entry.type === "custom" && entry.customType === "koni.attempt-session-map");
  assert.equal(header.id, planning.sessionId);
  assert.equal(mapping.data.attemptId, planning.id);
  assert.equal(mapping.data.sessionId, planning.sessionId);
  assert.equal(mapping.data.specHash, planning.launchSpecHash);
  const transcript = (await client.request("run.transcript", {
    runId,
    attemptId: planning.id,
  })).result;
  assert.equal(transcript.header.id, planning.sessionId);
  assert.equal(transcript.entries.filter((entry) =>
    entry.type === "custom" && entry.customType === "koni.attempt-session-map").length, 1);
  const usageBeforePause = Object.values(run.attempts).reduce((total, attempt) => total +
    attempt.inputTokens + attempt.outputTokens + attempt.cacheReadTokens + attempt.cacheWriteTokens, 0);
  assert.equal(usageBeforePause, 0, "provider-free admission must withhold activation and spend no tokens");

  await client.request("run.pause", { runId }, {
    expectedRevision: client.revision,
    idempotencyKey: "packed-provider-free-attempt-pause",
  });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    run = (await client.request("run.get", { runId })).result;
    planning = run.attempts[planning.id];
    if (run.lifecycle.phase === "paused" && ["aborted", "interrupted"].includes(planning.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(run.lifecycle.phase, "paused");
  assert.match(planning.status, /^(?:aborted|interrupted)$/u);
  const usageAfterPause = Object.values(run.attempts).reduce((total, attempt) => total +
    attempt.inputTokens + attempt.outputTokens + attempt.cacheReadTokens + attempt.cacheWriteTokens, 0);
  assert.equal(usageAfterPause, 0);

  await client.request("run.delete", { runId }, {
    expectedRevision: client.revision,
    idempotencyKey: "packed-provider-free-attempt-delete",
  });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    run = (await client.request("run.get", { runId })).result;
    if (run.lifecycle.phase === "deleted") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(run.lifecycle.phase, "deleted");
  const finalUsage = Object.values(run.attempts).reduce((total, attempt) => total +
    attempt.inputTokens + attempt.outputTokens + attempt.cacheReadTokens + attempt.cacheWriteTokens, 0);
  assert.equal(finalUsage, 0);
  process.stdout.write(JSON.stringify({
    runId,
    attemptId: planning.id,
    sessionId: planning.sessionId,
    specHash: planning.launchSpecHash,
    phase: run.lifecycle.phase,
    status: planning.status,
    usage: finalUsage,
  }));
} finally {
  client?.close();
  requestShutdown();
  await serving;
}
`, "utf8");

  const result = await execFileAsync(process.execPath, [helper], {
    cwd: project,
    env: environment,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.phase, "deleted");
  assert.match(evidence.status, /^(?:aborted|interrupted)$/u);
  assert.equal(evidence.usage, 0);
  assert.match(evidence.specHash, /^sha256:[a-f0-9]{64}$/u);
}

async function constructAndAbortAgentSession({ stockPiRoot, agent, project, root }) {
  const sdkURL = pathToFileURL(path.join(
    stockPiRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "index.js",
  )).href;
  const {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
  } = await import(sdkURL);
  const settingsManager = SettingsManager.create(project, agent, { projectTrusted: true });
  const resourceLoader = new DefaultResourceLoader({ cwd: project, agentDir: agent, settingsManager });
  await resourceLoader.reload({ resolveProjectTrust: async () => true });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(root, "isolated-empty-auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const { session, extensionsResult } = await createAgentSession({
    cwd: project,
    agentDir: agent,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(project),
    modelRuntime,
    noTools: "all",
  });
  try {
    assert.equal(session.isStreaming, false);
    assert.equal(extensionsResult.errors?.length ?? 0, 0,
      JSON.stringify(extensionsResult.errors ?? []));
    await session.abort();
  } finally {
    session.dispose();
  }
}

async function exerciseInstalledPiResources({ pi, project, agent, environment }) {
  const child = spawn(pi, ["--mode", "rpc", "--no-session"], {
    cwd: project,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
    const response = await waitForRpcResponse(child, () => stdout, () => stderr, "commands");
    const commands = response.data?.commands ?? [];
    const inventory = JSON.stringify(commands.map(({ name, source }) => ({ name, source })));
    assert.ok(commands.some((command) => command.name === "koni" && command.source === "extension"), inventory);
    assert.ok(commands.some((command) => command.name === "skill:ambient-skill"), inventory);
    for (const skill of ["configure-koni", "model-koni-work", "operate-koni"]) {
      assert.ok(commands.some((command) => command.name === `skill:${skill}` && command.source === "skill"), inventory);
    }
    assert.equal(existsSync(path.join(project, ".koni")), false,
      "extension/session construction must not initialize the project");
    const piStateBeforeOperations = await snapshotTree(agent);

    child.stdin.write(`${JSON.stringify({ id: "init", type: "prompt", message: "/koni init coding" })}\n`);
    await waitForRpcResponse(child, () => stdout, () => stderr, "init");
    assert.equal(existsSync(path.join(project, ".koni", "project.yaml")), true);
    assert.equal(existsSync(path.join(project, ".koni", ".managed", "install.json")), true);

    child.stdin.write(`${JSON.stringify({ id: "config", type: "prompt", message: "/koni config" })}\n`);
    await waitForRpcResponse(child, () => stdout, () => stderr, "config");
    assert.deepEqual(await snapshotTree(agent), piStateBeforeOperations,
      "Koni operations must not alter Pi credentials, settings, packages, or ambient resources");
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
  }
}

async function assertLegacyDuplicateCoreFailsClosed({ pi, agent, root, environment }) {
  const project = path.join(root, "duplicate-core-project");
  const legacyPackage = path.join(root, "legacy-core-package");
  const marker = path.join(project, "legacy-command-ran");
  await Promise.all([
    mkdir(path.join(project, ".pi"), { recursive: true }),
    mkdir(legacyPackage),
  ]);
  await execFileAsync("git", ["init", "-q"], { cwd: project });
  await writeFile(path.join(legacyPackage, "package.json"), `${JSON.stringify({
    name: "legacy-koni-core-fixture",
    version: "0.0.1",
    type: "module",
    pi: { extensions: ["./extension.js"] },
  }, null, 2)}\n`);
  await writeFile(path.join(legacyPackage, "extension.js"), `
import { writeFile } from "node:fs/promises";
export default function legacyKoniCore(pi) {
  pi.registerCommand("koni", {
    description: "Guard-unaware legacy Koni fixture",
    handler: async () => { await writeFile(${JSON.stringify(marker)}, "unsafe legacy handler ran\\n"); },
  });
}
`);
  const projectSettingsPath = path.join(project, ".pi", "settings.json");
  const projectSettingsBytes = `${JSON.stringify({
    packages: [legacyPackage],
    prompts: [path.join(project, "unrelated-project-prompt.md")],
  }, null, 2)}\n`;
  await writeFile(path.join(project, "unrelated-project-prompt.md"), "Unrelated project prompt.\n");
  await writeFile(projectSettingsPath, projectSettingsBytes);
  const agentBefore = await snapshotTree(agent);
  let shutdown;
  await assert.rejects(
    execFileAsync(pi, ["--mode", "rpc", "--no-session", "--approve"], {
      cwd: project,
      env: environment,
      timeout: 20_000,
    }),
    (error) => {
      shutdown = error;
      return error.code === 143 || error.signal === "SIGTERM";
    },
    "duplicate Core detection must terminate the unsafe Pi process",
  );
  const output = `${shutdown.stdout}\n${shutdown.stderr}`;
  assert.match(output, /Multiple @koni\/core origins are loaded/u);
  assert.match(output, /Pi renamed \/koni/u);
  assert.match(output, new RegExp(`pi remove .*${escapeRegExp(legacyPackage)}.* --local`, "u"),
    "duplicate remediation must name the exact project-local source and scope");
  assert.equal(existsSync(marker), false, "Pi must shut down before a guard-unaware legacy command can run");
  assert.equal(await readFile(projectSettingsPath, "utf8"), projectSettingsBytes,
    "duplicate detection must not remove or rewrite project resources itself");
  assert.deepEqual(await snapshotTree(agent), agentBefore,
    "duplicate detection must preserve global Pi credentials, settings, and unrelated resources");
}

async function snapshotAmbient(agent, ambientPackage) {
  const authPath = path.join(agent, "auth.json");
  return {
    ambientPackage: await snapshotTree(ambientPackage),
    prompt: await readFile(path.join(agent, "ambient-prompt.md"), "base64"),
    auth: await readFile(authPath, "base64"),
    authMode: (await stat(authPath)).mode & 0o777,
    settings: JSON.parse(await readFile(path.join(agent, "settings.json"), "utf8")),
  };
}

async function assertAmbientPreserved(agent, ambientPackage, before, archives) {
  assert.deepEqual(await snapshotTree(ambientPackage), before.ambientPackage);
  assert.equal(await readFile(path.join(agent, "ambient-prompt.md"), "base64"), before.prompt);
  assert.equal(await readFile(path.join(agent, "auth.json"), "base64"), before.auth,
    "Koni package/install/runtime operations must preserve Pi credential bytes exactly");
  assert.equal((await stat(path.join(agent, "auth.json"))).mode & 0o777, before.authMode,
    "Koni must preserve Pi credential permissions exactly");
  const after = JSON.parse(await readFile(path.join(agent, "settings.json"), "utf8"));
  assert.equal(after.quietStartup, before.settings.quietStartup);
  assert.equal(after.enableAnalytics, before.settings.enableAnalytics);
  assert.deepEqual(after.npmCommand, before.settings.npmCommand);
  assert.deepEqual(after.prompts, before.settings.prompts);
  assert.ok(after.packages.includes(ambientPackage));
  for (const [name, value] of archives) assert.ok(after.packages.includes(`npm:${name}@${value.version}`));
}

function providerFreeEnvironment(overrides) {
  const environment = { ...process.env, ...overrides };
  for (const name of Object.keys(environment)) {
    if (/(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|SECRET[_-]?KEY)$/iu.test(name)) delete environment[name];
  }
  return environment;
}

async function stopDisposableAuthority(project) {
  const lease = path.join(project, ".git", "koni", "authority", "lease.json");
  if (!existsSync(lease)) return;
  let pid;
  try {
    pid = JSON.parse(await readFile(lease, "utf8")).pid;
  } catch {
    return;
  }
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      return;
    }
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
}

async function listRelativePaths(root, current = root) {
  if (!existsSync(current)) return [];
  const result = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    result.push(relative);
    if (entry.isDirectory()) result.push(...await listRelativePaths(root, absolute));
  }
  return result;
}

async function snapshotTree(root, current = root) {
  const snapshot = {};
  if (!existsSync(current)) return snapshot;
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isDirectory()) Object.assign(snapshot, await snapshotTree(root, absolute));
    else if (entry.isFile()) snapshot[relative] = (await readFile(absolute)).toString("base64");
    else snapshot[relative] = `<${entry.isSymbolicLink() ? "symlink" : "other"}>`;
  }
  return snapshot;
}

function waitForRpcResponse(child, stdout, stderr, id) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Pi RPC timed out\nstdout=${stdout()}\nstderr=${stderr()}`));
    }, 30_000);
    const inspect = () => {
      for (const line of stdout().split("\n")) {
        if (line.length === 0) continue;
        let value;
        try { value = JSON.parse(line); } catch { continue; }
        if (value.type === "response" && value.id === id) {
          clearTimeout(timeout);
          child.stdout.off("data", inspect);
          if (value.success !== true) reject(new Error(`Pi RPC rejected ${id}: ${value.error ?? "unknown"}`));
          else resolve(value);
          return;
        }
      }
    };
    child.stdout.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      inspect();
      if (!stdout().includes(`\"id\":\"${id}\"`)) {
        clearTimeout(timeout);
        reject(new Error(`Pi exited ${code}\nstdout=${stdout()}\nstderr=${stderr()}`));
      }
    });
  });
}

function firstJsonLine(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`packed authority racer timed out\nstdout=${stdout}\nstderr=${stderr}`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const inspect = (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timeout);
      child.stdout.off("data", inspect);
      try { resolve(JSON.parse(stdout.slice(0, newline))); }
      catch (error) { reject(new Error(`packed authority racer emitted invalid JSON: ${stdout}`, { cause: error })); }
    };
    child.stdout.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!stdout.includes("\n")) {
        clearTimeout(timeout);
        reject(new Error(`packed authority racer exited ${code}\nstdout=${stdout}\nstderr=${stderr}`));
      }
    });
  });
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child ${child.pid} did not exit`)), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function waitForExists(target) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(target)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${target}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
