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
const superpowersPackageSource = "git:github.com/obra/superpowers";
const superpowersCloneUrl = "https://github.com/obra/superpowers";
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
const offlineSuperpowersSkillIds = [
  "brainstorming",
  "dispatching-parallel-agents",
  "executing-plans",
  "finishing-a-development-branch",
  "receiving-code-review",
  "requesting-code-review",
  "subagent-driven-development",
  "systematic-debugging",
  "test-driven-development",
  "using-git-worktrees",
  "using-superpowers",
  "verification-before-completion",
  "writing-plans",
  "writing-skills",
];

test("the package rehearsal resolves the exact required Git package from a network-sealed fixture", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "koni-hermetic-git-package-"));
  try {
    const fixture = await createHermeticSuperpowersGitFixture(root);
    const clone = path.join(root, "resolved-superpowers");
    await execFileAsync("git", ["clone", superpowersCloneUrl, clone], {
      env: providerFreeEnvironment(fixture.environment),
    });
    assert.deepEqual(
      (await readdir(path.join(clone, "skills"))).sort(),
      offlineSuperpowersSkillIds,
      "the exact stock-Pi clone URL must resolve every required public skill identity",
    );
    assert.equal(
      (await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: clone })).stdout.trim(),
      superpowersCloneUrl,
      "the local transport substitution must preserve the production package identity",
    );
    await assert.rejects(
      execFileAsync("git", ["clone", `${superpowersCloneUrl}-fork`, path.join(root, "forbidden")], {
        env: providerFreeEnvironment(fixture.environment),
      }),
      "a neighboring HTTPS source must remain denied rather than matching a broad redirect",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createHermeticSuperpowersGitFixture(root) {
  const repository = path.join(root, "superpowers-source");
  const config = path.join(root, "network-sealed-gitconfig");
  await mkdir(path.join(repository, "skills"), { recursive: true });
  for (const id of offlineSuperpowersSkillIds) {
    const skillRoot = path.join(repository, "skills", id);
    await mkdir(skillRoot);
    await writeFile(
      path.join(skillRoot, "SKILL.md"),
      `---\nname: ${id}\ndescription: Hermetic package-smoke materialization of a declared Pi skill.\n---\n\nProvider-free package-smoke resource.\n`,
      "utf8",
    );
  }
  await execFileAsync("git", ["init", "-q"], { cwd: repository });
  await execFileAsync("git", ["add", "skills"], { cwd: repository });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Koni package smoke",
      "-c",
      "user.email=koni-smoke@example.invalid",
      "commit",
      "-q",
      "-m",
      `Materialize ${superpowersPackageSource}`,
    ],
    { cwd: repository },
  );

  const localCloneUrl = pathToFileURL(repository).href;
  for (const [key, value] of [
    [`url.${localCloneUrl}.insteadOf`, superpowersCloneUrl],
    ["protocol.file.allow", "always"],
    ["protocol.http.allow", "never"],
    ["protocol.https.allow", "never"],
    ["protocol.git.allow", "never"],
    ["protocol.ssh.allow", "never"],
  ]) {
    await execFileAsync("git", ["config", "--file", config, key, value]);
  }
  return {
    repository,
    config,
    environment: {
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  };
}

test("shipping manifests reuse Pi's bundled SDK while the development runtime stays exact", async () => {
  const root = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const manifests = await Promise.all(
    [...publicPackages.values()].map(async (name) =>
      JSON.parse(
        await readFile(path.join(repositoryRoot, "packages", name, "package.json"), "utf8"),
      ),
    ),
  );
  assert.equal(root.devDependencies["@earendil-works/pi-coding-agent"], stockPiVersion);
  assert.equal(root.devDependencies.typebox, stockTypeboxVersion);
  assert.equal(manifests[0].bin.koni, "./bin/koni.js");
  assert.equal(
    manifests[0].koni.pi_range,
    stockPiVersion,
    "the shipping launcher must advertise the exact Pi runtime it verifies",
  );
  for (const manifest of manifests) {
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (bundledPeers.includes(name)) {
        assert.equal(range, "*", `${manifest.name} must reuse Pi's ${name}`);
        assert.equal(
          manifest.peerDependenciesMeta?.[name]?.optional,
          true,
          `${manifest.name} must prevent npm from auto-installing Pi's host peer ${name}`,
        );
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
  await Promise.all([mkdir(path.join(prefix, "bin"), { recursive: true }), mkdir(shadow)]);
  try {
    for (const executable of [path.join(prefix, "bin", "koni"), path.join(shadow, "koni")]) {
      await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(executable, 0o755);
    }
    const systemPath = "/usr/bin:/bin";
    const shadowed = await execFileAsync("/bin/bash", [script, prefix], {
      env: {
        ...process.env,
        PATH: `${shadow}${path.delimiter}${path.join(prefix, "bin")}${path.delimiter}${systemPath}`,
      },
    });
    assert.match(shadowed.stdout, new RegExp(escapeRegExp(path.join(shadow, "koni")), "u"));
    assert.match(shadowed.stdout, /Prepend the activated Koni command directory/u);
    const active = await execFileAsync("/bin/bash", [script, prefix], {
      env: {
        ...process.env,
        PATH: `${path.join(prefix, "bin")}${path.delimiter}${shadow}${path.delimiter}${systemPath}`,
      },
    });
    assert.equal(active.stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test(
  "exact tarballs run through stock Pi without a second SDK, credential mutation, or provider calls",
  {
    // This is one release rehearsal composed of several independently bounded phases: npm installs,
    // Pi-managed installs, registrar crash recovery, a daemon race, and a contained production
    // session. A busy verification host can legitimately spend close to the old four-minute outer
    // limit even though no individual child is unbounded. Keep enough aggregate headroom that the
    // outer harness does not kill a healthy final phase while retaining all per-operation timeouts.
    timeout: 420_000,
  },
  async () => {
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
      mkdir(path.join(ambientPackage, "extensions"), { recursive: true }),
    ]);

    try {
      await Promise.all([
        execFileAsync("git", ["init", "-q"], { cwd: project }),
        execFileAsync("git", ["init", "-q"], { cwd: cliProject }),
      ]);
      await initializeDisposableGitProject(project);
      await installStockPi(stockPiRoot);
      const piPackageRoot = path.join(
        stockPiRoot,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
      );
      const pi = path.join(
        stockPiRoot,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "pi.cmd" : "pi",
      );
      assert.equal(
        JSON.parse(await readFile(path.join(piPackageRoot, "package.json"), "utf8")).version,
        stockPiVersion,
      );
      assert.equal(
        JSON.parse(
          await readFile(
            path.join(piPackageRoot, "node_modules", "typebox", "package.json"),
            "utf8",
          ),
        ).version,
        stockTypeboxVersion,
      );
      await assertLauncherDiscoveryShapes({ root, pi, piPackageRoot });

      const archives = await exactArchives(root);
      const npmCache = path.join(root, "npm-cache");
      const offlineDependencies = await packOfflineRuntimeDependencies(root, npmCache);
      await assertOrdinaryNpmDoesNotInstallHostPeers({
        root,
        archives,
        offlineDependencies,
        npmCache,
        pi,
        home,
      });
      await writeTarballWrapper(wrapper);
      await writeAmbientResources(agent, ambientPackage, wrapper);
      const gitPackageFixture = await createHermeticSuperpowersGitFixture(root);
      const ambientBefore = await snapshotAmbient(agent, ambientPackage);
      const piEnvironment = providerFreeEnvironment({
        HOME: home,
        PI_CODING_AGENT_DIR: agent,
        // Stock Pi treats PI_OFFLINE as "skip every missing package", before Git gets a chance to
        // resolve the exact configured source. Git's isolated protocol policy below is the network
        // boundary for that real resolution path; npm and model access remain sealed separately.
        PI_OFFLINE: undefined,
        npm_config_audit: "false",
        npm_config_cache: npmCache,
        npm_config_fund: "false",
        npm_config_offline: "true",
        npm_config_update_notifier: "false",
        ...gitPackageFixture.environment,
        KONI_SMOKE_TARBALL_MAP: JSON.stringify(
          Object.fromEntries(
            [...archives].map(([name, value]) => [`${name}@${value.version}`, value.archive]),
          ),
        ),
      });

      // Koni's two ordinary runtime dependencies are packed from this repository's exact installed
      // development closure and seeded into Pi's owned package root. The release archives remain
      // byte-for-byte untouched, while npm can resolve their dependency graph with an empty,
      // test-owned cache and `offline=true` instead of consulting a registry.
      await execFileAsync(
        "npm",
        [
          "install",
          "--prefix",
          path.join(agent, "npm"),
          "--legacy-peer-deps",
          "--no-audit",
          "--no-fund",
          ...offlineDependencies,
        ],
        { cwd: project, env: piEnvironment },
      );

      for (const [name, value] of archives) {
        await execFileAsync(pi, ["install", `npm:${name}@${value.version}`], {
          cwd: project,
          env: piEnvironment,
        });
      }
      await assertManagedInstall(agent, archives);
      await assertAmbientPreserved(agent, ambientPackage, ambientBefore, archives);

      const launcher = path.join(
        agent,
        "npm",
        "node_modules",
        ".bin",
        process.platform === "win32" ? "koni.cmd" : "koni",
      );
      assert.equal(
        existsSync(launcher),
        true,
        "Pi's one managed closure must expose the manual koni command",
      );
      const launcherEnvironment = {
        ...piEnvironment,
        // Exact Git installation is complete before provider-free Koni processes start. Restore
        // stock Pi's offline boundary so authorities, TUIs, and duplicate-source diagnostics cannot
        // refresh model/provider state while still reusing the already-resolved project package.
        PI_OFFLINE: "1",
        PATH: `${path.dirname(launcher)}${path.delimiter}${path.dirname(pi)}${path.delimiter}${piEnvironment.PATH ?? ""}`,
      };
      const commandName = process.platform === "win32" ? "koni.cmd" : "koni";
      const discoveredVersion = await execFileAsync(commandName, ["--version"], {
        cwd: cliProject,
        env: launcherEnvironment,
      });
      assert.equal(
        discoveredVersion.stdout.trim(),
        archives.get("@koni/core").version,
        "a clean PATH must discover the Pi-managed Koni command without a separate global install",
      );
      const version = await execFileAsync(launcher, ["--version"], {
        cwd: cliProject,
        env: launcherEnvironment,
      });
      assert.equal(version.stdout.trim(), archives.get("@koni/core").version);
      const help = await execFileAsync(launcher, ["--help"], {
        cwd: cliProject,
        env: launcherEnvironment,
      });
      assert.match(
        help.stdout,
        /koni tui \[--root PATH\]/u,
        "the packed shell entrypoint must expose the shared full control center",
      );
      await assert.rejects(
        execFileAsync(launcher, ["tui", "--root", cliProject], {
          cwd: cliProject,
          env: launcherEnvironment,
        }),
        (error) => {
          assert.match(String(error?.stderr ?? ""), /koni tui requires an interactive terminal/u);
          return true;
        },
        "the packed TUI command must be recognized and refuse only because this release probe has no TTY",
      );

      // Exercise the operator-facing package path before the slower registrar/race matrices so a
      // release UI failure remains quick to diagnose. The provider-free daemon is then quiesced; its
      // paused durable run remains available for the later preservation and uninstall assertions.
      await exerciseInstalledPiResources({ pi, project, agent, environment: piEnvironment });
      assert.deepEqual(
        JSON.parse(await readFile(path.join(project, ".pi", "settings.json"), "utf8")).packages,
        [superpowersPackageSource],
        "installed project settings must retain the exact production Superpowers package identity",
      );
      await commitDisposableKoniConfiguration(project, "Track installed Koni configuration");
      const handlerEvidence = await assertInstalledPiCommandHandlers({
        stockPiRoot,
        coreRoot: path.join(agent, "npm", "node_modules", "@koni", "core"),
        agent,
        project,
        root,
        environment: { ...piEnvironment, KONI_PI_PACKAGE_ROOT: piPackageRoot },
      });
      await commitDisposableKoniConfiguration(
        project,
        "Publish package-smoke project configuration",
      );
      await assertInstalledStandaloneTuiInRealPty({
        launcher,
        project,
        root,
        environment: launcherEnvironment,
        objective: handlerEvidence.objective,
      });
      await stopPackedAuthority({ launcher, project, environment: launcherEnvironment });

      const actionable = {
        coreRoot: path.join(agent, "npm", "node_modules", "@koni", "core"),
        stockPiRoot,
        agent,
        project,
        root,
        environment: { ...launcherEnvironment, KONI_PI_PACKAGE_ROOT: piPackageRoot },
        launcher,
        runId: handlerEvidence.runId,
        objective: handlerEvidence.objective,
      };
      await seedPackedActionableRun({ ...actionable, mode: "question" });
      await startPackedProviderFreeAuthority(actionable);
      await assertInstalledStandaloneTuiInRealPty({
        ...actionable,
        action: "answer_question",
      });
      await stopPackedAuthority({ launcher, project, environment: launcherEnvironment });

      await seedPackedActionableRun({ ...actionable, mode: "plan" });
      await startPackedProviderFreeAuthority(actionable);
      await assertInstalledPiPlanHandler({ ...actionable, action: "revise" });
      await stopPackedAuthority({ launcher, project, environment: launcherEnvironment });

      await seedPackedActionableRun({ ...actionable, mode: "revised_plan" });
      await startPackedProviderFreeAuthority(actionable);
      await assertInstalledPiPlanHandler({ ...actionable, action: "approve" });
      await stopPackedAuthority({ launcher, project, environment: launcherEnvironment });

      await seedPackedActionableRun({ ...actionable, mode: "merge" });
      await startPackedProviderFreeAuthority(actionable);
      await assertInstalledStandaloneTuiInRealPty({
        ...actionable,
        action: "merge",
      });
      await stopPackedAuthority({ launcher, project, environment: launcherEnvironment });
      await assertPackedActionableRunSettled(actionable);

      await assertVersionBundleIntegrity({ root, agent, archives });
      await assertAtomicRegistrarSafety({ root, stockPiRoot, agent });
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
        timeout: 75_000,
      });
      await stopPackedAuthority({
        launcher,
        project: cliProject,
        environment: launcherEnvironment,
      });
      const authoredProjectConfig = path.join(cliProject, ".koni", "project.yaml");
      await writeFile(
        authoredProjectConfig,
        `${await readFile(authoredProjectConfig, "utf8")}# package-smoke project override\n`,
        "utf8",
      );
      const authorityStateBeforeUpdate = await snapshotTree(path.join(cliProject, ".git", "koni"));
      await execFileAsync(launcher, ["update", "--root", cliProject], {
        cwd: cliProject,
        env: launcherEnvironment,
        timeout: 30_000,
      });
      assert.match(
        await readFile(authoredProjectConfig, "utf8"),
        /package-smoke project override/u,
        "a packed profile update must preserve project-authored configuration",
      );
      assert.deepEqual(
        await snapshotTree(path.join(cliProject, ".git", "koni")),
        authorityStateBeforeUpdate,
        "a packed profile update must not rewrite durable project authority or run state",
      );

      await assertPackedAuthorityRace({
        coreRoot: path.join(agent, "npm", "node_modules", "@koni", "core"),
        root,
        environment: launcherEnvironment,
        version: archives.get("@koni/core").version,
      });

      // The provider-free authority deliberately skips package installation under NODE_ENV=test.
      // Cross the same project-local stock-Pi resolution boundary an operator crosses before asking
      // Koni to create work, rather than borrowing the unrelated primary project's package cache.
      await resolveInstalledPiResources({
        stockPiRoot,
        agent,
        project: cliProject,
        root,
        environment: piEnvironment,
      });
      await assertHermeticSuperpowersResolution(cliProject);

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
      await assertInstalledStandaloneTui({
        coreRoot: path.join(agent, "npm", "node_modules", "@koni", "core"),
        project: cliProject,
        root,
        environment: launcherEnvironment,
        version: archives.get("@koni/core").version,
      });
      await stopDisposableAuthority(cliProject);
      assert.deepEqual(
        await snapshotTree(agent),
        piStateBeforeSession,
        "provider-free sessions and the quiesced standalone authority must not alter ambient Pi state",
      );

      await assertLegacyDuplicateCoreIsInert({ pi, agent, root, environment: launcherEnvironment });
      await assertAmbientPreserved(agent, ambientPackage, ambientBefore, archives);
      await stopDisposableAuthority(project);
      await stopDisposableAuthority(cliProject);
      await uninstallKoniPackages({
        pi,
        project,
        agent,
        ambientPackage,
        ambientBefore,
        archives,
        environment: piEnvironment,
      });
    } finally {
      await stopDisposableAuthority(project);
      await stopDisposableAuthority(cliProject);
      if (process.env.KONI_KEEP_PACKAGE_SMOKE === "1") {
        process.stderr.write(`Preserved package smoke root for diagnosis: ${root}\n`);
      } else {
        // Packed attempts deliberately leave their content-addressed runtime generation sealed with
        // read/execute-only directories. That cache is required in a real project so a paused run can
        // resume after the mutable package installation changes. This fixture owns its entire
        // disposable root, so restore directory write permission before removing the temporary tree;
        // do not weaken the production stage modes merely to make test teardown convenient.
        await makeDisposableTreeRemovable(root);
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);

async function assertLauncherDiscoveryShapes({ root, pi, piPackageRoot }) {
  const { findPiPackageRoot, preparePiRuntime } = await import(
    pathToFileURL(path.join(repositoryRoot, "packages", "core", "bin", "koni.js")).href
  );
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
  await writeFile(path.join(decoyDirectory, "pi"), "not executable\n", {
    encoding: "utf8",
    mode: 0o644,
  });
  await writeFile(
    path.join(dottedRoot, "package.json"),
    `${JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: stockPiVersion,
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(prereleaseRoot, "package.json"),
    `${JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: `${stockPiVersion}-beta.1`,
    })}\n`,
    "utf8",
  );
  try {
    delete process.env.KONI_PI_PACKAGE_ROOT;
    process.env.PATH = posixDirectory;
    const canonicalPiRoot = await realpath(piPackageRoot);
    assert.equal(
      findPiPackageRoot(),
      canonicalPiRoot,
      "regular POSIX wrappers must resolve their real Pi runtime",
    );
    process.env.PATH = windowsDirectory;
    assert.equal(
      findPiPackageRoot(),
      canonicalPiRoot,
      "regular Windows cmd shims must resolve their real Pi runtime",
    );
    process.env.PATH = `${decoyDirectory}${path.delimiter}${posixDirectory}`;
    assert.equal(
      findPiPackageRoot(),
      canonicalPiRoot,
      "a non-executable PATH decoy must not shadow the Pi executable the shell would run",
    );
    process.env.PATH = `${opaqueDirectory}${path.delimiter}${path.dirname(pi)}`;
    assert.throws(
      () => findPiPackageRoot(),
      /active Pi wrapper .* is opaque/u,
      "an opaque first PATH Pi must fail closed instead of selecting a different later runtime",
    );
    process.env.KONI_PI_PACKAGE_ROOT = dottedRoot;
    process.env.PATH = "";
    assert.equal(findPiPackageRoot(), dottedRoot, "explicit valid package roots may contain dots");
    process.env.KONI_PI_PACKAGE_ROOT = prereleaseRoot;
    await assert.rejects(
      preparePiRuntime(),
      /active Pi runtime must be 0\.80\.10/u,
      "a prerelease or build variant must not satisfy the exact tested Pi contract",
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalRoot === undefined) delete process.env.KONI_PI_PACKAGE_ROOT;
    else process.env.KONI_PI_PACKAGE_ROOT = originalRoot;
  }
}

async function assertOrdinaryNpmDoesNotInstallHostPeers({
  root,
  archives,
  offlineDependencies,
  npmCache,
  pi,
  home,
}) {
  const prefix = path.join(root, "global-prefix");
  await mkdir(prefix);
  await execFileAsync(
    "npm",
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--offline",
      ...offlineDependencies,
      ...[...archives.values()].map((value) => value.archive),
    ],
    {
      env: providerFreeEnvironment({
        HOME: home,
        npm_config_cache: npmCache,
        npm_config_offline: "true",
      }),
    },
  );
  const { stdout } = await execFileAsync("npm", ["root", "--global", "--prefix", prefix], {
    env: providerFreeEnvironment({
      HOME: home,
      npm_config_cache: npmCache,
      npm_config_offline: "true",
    }),
  });
  const globalRoot = stdout.trim();
  for (const peer of bundledPeers) {
    assert.equal(
      existsSync(path.join(globalRoot, ...peer.split("/"))),
      false,
      `ordinary npm must not auto-install optional Pi host peer ${peer}`,
    );
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
  const pinnedNodeModules = path.join(repositoryRoot, "node_modules");
  const pinnedPiManifest = JSON.parse(
    await readFile(
      path.join(pinnedNodeModules, "@earendil-works", "pi-coding-agent", "package.json"),
      "utf8",
    ),
  );
  assert.equal(
    pinnedPiManifest.version,
    stockPiVersion,
    "the package rehearsal must use the repository's exact pinned stock Pi runtime",
  );
  await writeFile(
    path.join(stockPiRoot, "package.json"),
    `${JSON.stringify({
      private: true,
      description: `read-only stock Pi ${stockPiVersion} facade for Koni's package rehearsal`,
    })}\n`,
    "utf8",
  );
  await symlink(pinnedNodeModules, path.join(stockPiRoot, "node_modules"), "dir");
}

async function packOfflineRuntimeDependencies(root, npmCache) {
  const archiveDirectory = path.join(root, "offline-runtime-dependencies");
  await mkdir(archiveDirectory);
  const expected = new Map([
    ["semver", "7.8.5"],
    ["yaml", "2.9.0"],
  ]);
  for (const [name, version] of expected) {
    const source = path.join(repositoryRoot, "node_modules", name);
    const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
    assert.equal(
      manifest.version,
      version,
      `the offline smoke closure must pin ${name}@${version}`,
    );
    await execFileAsync(
      "npm",
      ["pack", source, "--pack-destination", archiveDirectory, "--ignore-scripts"],
      {
        cwd: repositoryRoot,
        env: providerFreeEnvironment({
          npm_config_cache: npmCache,
          npm_config_offline: "true",
        }),
      },
    );
  }
  const archives = (await readdir(archiveDirectory))
    .filter((entry) => entry.endsWith(".tgz"))
    .sort()
    .map((entry) => path.join(archiveDirectory, entry));
  assert.equal(
    archives.length,
    expected.size,
    "the offline npm seed must contain only Koni's two ordinary runtime dependencies",
  );
  return archives;
}

async function initializeDisposableGitProject(project) {
  await writeFile(
    path.join(project, "README.md"),
    "Disposable Koni package/UI rehearsal.\n",
    "utf8",
  );
  await execFileAsync("git", ["add", "README.md"], { cwd: project });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Koni package smoke",
      "-c",
      "user.email=koni-smoke@example.invalid",
      "commit",
      "-q",
      "-m",
      "Initialize disposable Pi project",
    ],
    { cwd: project },
  );
  await execFileAsync("git", ["branch", "-M", "main"], { cwd: project });
}

async function commitDisposableKoniConfiguration(project, message) {
  const status = await execFileAsync("git", ["status", "--short", "--untracked-files=all"], {
    cwd: project,
  });
  const changes = status.stdout.split("\n").filter(Boolean);
  assert.ok(changes.length > 0, `${message} expected a project-authored Koni change`);
  const piGitCacheGuard = ".pi/git/.gitignore";
  const piCacheGuardPresent = changes.some((line) => line === `?? ${piGitCacheGuard}`);
  const escaped = changes.filter((line) => {
    const target = line.slice(3);
    return (
      !target.startsWith(".koni/") && target !== ".pi/settings.json" && target !== piGitCacheGuard
    );
  });
  assert.deepEqual(
    escaped,
    [],
    `package rehearsal configuration commit observed an unexpected authored surface: ${changes.join(", ")}`,
  );
  if (piCacheGuardPresent) {
    assert.equal(
      await readFile(path.join(project, piGitCacheGuard), "utf8"),
      "*\n!.gitignore\n",
      "stock Pi's project package cache must retain its exact ignore guard",
    );
  }
  await execFileAsync(
    "git",
    ["add", ".koni", ".pi/settings.json", ...(piCacheGuardPresent ? [piGitCacheGuard] : [])],
    { cwd: project },
  );
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Koni package smoke",
      "-c",
      "user.email=koni-smoke@example.invalid",
      "commit",
      "-q",
      "-m",
      message,
    ],
    { cwd: project },
  );
  if (piCacheGuardPresent) {
    const after = await execFileAsync("git", ["status", "--short", "--untracked-files=all"], {
      cwd: project,
    });
    assert.equal(
      after.stdout.trim(),
      "",
      "the disposable operator commit must leave the target checkout clean for promotion",
    );
    assert.equal(
      (
        await execFileAsync("git", ["ls-files", "--error-unmatch", piGitCacheGuard], {
          cwd: project,
        })
      ).stdout.trim(),
      piGitCacheGuard,
      "the exact Pi package-cache guard must be tracked while cached package bytes stay ignored",
    );
  }
}

async function exactArchives(root) {
  const configured = process.env.KONI_PACKAGE_ARCHIVES_DIR;
  const archiveDirectory =
    configured === undefined ? path.join(root, "archives") : path.resolve(configured);
  if (configured === undefined) {
    await mkdir(archiveDirectory);
    for (const workspace of publicPackages.keys()) {
      await execFileAsync(
        "npm",
        ["pack", "--workspace", workspace, "--pack-destination", archiveDirectory],
        { cwd: repositoryRoot },
      );
    }
  }
  const files = (await readdir(archiveDirectory)).filter((entry) => entry.endsWith(".tgz")).sort();
  assert.equal(files.length, 3, "the smoke requires exactly the three release tarballs");
  const result = new Map();
  for (const file of files) {
    const archive = path.join(archiveDirectory, file);
    const { stdout } = await execFileAsync("tar", ["-xOf", archive, "package/package.json"]);
    const manifest = JSON.parse(stdout);
    assert.equal(
      publicPackages.has(manifest.name),
      true,
      `unexpected release archive ${manifest.name}`,
    );
    const sha256 = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    result.set(manifest.name, { archive, version: manifest.version, sha256 });
  }
  assert.deepEqual([...result.keys()].sort(), [...publicPackages.keys()].sort());
  assert.equal(
    new Set([...result.values()].map((value) => value.sha256)).size,
    3,
    "the release rehearsal must install three distinct immutable archives",
  );
  return result;
}

async function writeTarballWrapper(wrapper) {
  await writeFile(
    wrapper,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const mapping = JSON.parse(process.env.KONI_SMOKE_TARBALL_MAP ?? "{}");
const args = process.argv.slice(2).map((value) => mapping[value] ?? value);
const result = spawnSync("npm", args, { env: process.env, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`,
    "utf8",
  );
  await chmod(wrapper, 0o755);
}

async function writeAmbientResources(agent, ambientPackage, wrapper) {
  await writeFile(
    path.join(ambientPackage, "package.json"),
    `${JSON.stringify(
      {
        name: "ambient-pi-package",
        version: "1.0.0",
        pi: {
          extensions: ["./extensions/ambient.ts"],
          skills: ["./skills"],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(ambientPackage, "extensions", "ambient.ts"),
    `
export default function ambientPiExtension(pi) {
  pi.registerCommand("ambient-extension", {
    description: "Disposable unrelated extension preserved by Koni's package smoke",
    handler: async () => undefined,
  });
}
`,
    "utf8",
  );
  await writeFile(
    path.join(ambientPackage, "skills", "ambient-skill", "SKILL.md"),
    `---
name: ambient-skill
description: Disposable ambient Pi resource used by Koni's package-preservation smoke.
---
Ambient skill body.
`,
    "utf8",
  );
  await writeFile(path.join(agent, "ambient-prompt.md"), "Ambient prompt.\n", "utf8");
  await writeFile(
    path.join(agent, "auth.json"),
    `${JSON.stringify(
      {
        "koni-smoke-fixture": { type: "api_key", key: "not-a-real-credential" },
        // The packaged release probe withholds attempt activation. This syntactically valid, entirely
        // fake, far-future record only makes Pi's offline built-in model catalog selectable in the
        // real guided modal; it is never refreshed or sent to a provider and is restored byte-for-byte.
        "openai-codex": {
          type: "oauth",
          access: "not-a-real-access-token",
          refresh: "not-a-real-refresh-token",
          expires: 4_102_444_800_000,
        },
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await writeFile(path.join(agent, "models-store.json"), "{}", { encoding: "utf8", mode: 0o600 });
  await writeFile(
    path.join(agent, "settings.json"),
    JSON.stringify(
      {
        quietStartup: true,
        enableAnalytics: false,
        npmCommand: [process.execPath, wrapper],
        packages: [ambientPackage],
        prompts: [path.join(agent, "ambient-prompt.md")],
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function assertManagedInstall(agent, archives) {
  const managedRoot = path.join(agent, "npm", "node_modules");
  for (const peer of bundledPeers) {
    assert.equal(
      existsSync(path.join(managedRoot, ...peer.split("/"))),
      false,
      `Pi-managed Koni packages must not install a second ${peer}`,
    );
  }
  const allPaths = await listRelativePaths(path.join(agent, "npm"));
  for (const peer of bundledPeers) {
    const marker = `/node_modules/${peer}/`;
    assert.equal(
      allPaths.some((entry) => `/${entry}/`.includes(marker)),
      false,
      `nested ${peer} copy detected in Koni's managed package closure`,
    );
  }
  for (const [name, value] of archives) {
    const manifest = JSON.parse(
      await readFile(path.join(managedRoot, ...name.split("/"), "package.json"), "utf8"),
    );
    assert.equal(manifest.version, value.version);
  }
}

async function assertVersionBundleIntegrity({ root, agent, archives }) {
  const bundleTool = path.join(repositoryRoot, "scripts", "dev-package-bundle.mjs");
  const valid = path.join(root, "sealed-package-root");
  await cp(path.join(agent, "npm"), valid, { recursive: true, dereference: false });
  await rm(path.join(valid, "node_modules", ".bin"), { recursive: true, force: true });
  const bundleId = createHash("sha256");
  for (const { archive } of [...archives.values()].sort((left, right) =>
    left.archive.localeCompare(right.archive),
  )) {
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
  await assert.rejects(
    execFileAsync(process.execPath, [bundleTool, "verify", valid, digest]),
    "an authenticated existing root must reject post-seal content changes",
  );
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
  await writeFile(
    path.join(registrarAgent, "settings.json"),
    `${JSON.stringify(globalSettings, null, 2)}\n`,
  );
  const registrarAuthPath = path.join(registrarAgent, "auth.json");
  const registrarAuthBytes = `${JSON.stringify(
    {
      "fixture-provider": { type: "api_key", key: "not-a-real-registrar-credential" },
    },
    null,
    2,
  )}\n`;
  await writeFile(registrarAuthPath, registrarAuthBytes, { encoding: "utf8", mode: 0o600 });
  await writeFile(
    path.join(registrarProject, ".pi", "settings.json"),
    `${JSON.stringify(projectSettings, null, 2)}\n`,
  );
  const roots = [...publicPackages.keys()].map((name) =>
    path.join(agent, "npm", "node_modules", ...name.split("/")),
  );
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
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [registrar, "activate", journal, launcher, launcherTarget, ...roots],
      {
        cwd: registrarProject,
        env: {
          ...environment,
          NODE_ENV: "test",
          KONI_TEST_CRASH_AFTER_FSYNC: "journal",
        },
      },
    ),
  );
  assert.equal(
    existsSync(journal),
    false,
    "a killed journal publish must expose no partial final journal",
  );
  assert.equal(
    await readFile(path.join(registrarAgent, "settings.json"), "utf8"),
    initialSettingsBytes,
  );
  assert.equal(await readFile(registrarAuthPath, "utf8"), registrarAuthBytes);
  await execFileAsync(
    process.execPath,
    [registrar, "activate", journal, launcher, launcherTarget, ...roots],
    {
      cwd: registrarProject,
      env: environment,
    },
  );
  const activationJournal = await readFile(journal, "utf8");
  assert.equal(
    activationJournal.includes(legacySettingsCredential),
    false,
    "the activation journal must never copy legacy settings credentials",
  );
  assert.equal(
    activationJournal.includes("apiKeys"),
    false,
    "the activation journal must contain identities and Koni package entries, not full settings",
  );
  assert.equal(
    activationJournal.includes(Buffer.from(legacySettingsCredential).toString("base64")),
    false,
  );
  await fsSymlink(launcherTarget, launcher);
  await execFileAsync(process.execPath, [registrar, "commit", journal, launcher], {
    cwd: registrarProject,
    env: environment,
  });
  const globalAfter = JSON.parse(
    await readFile(path.join(registrarAgent, "settings.json"), "utf8"),
  );
  const projectAfter = JSON.parse(
    await readFile(path.join(registrarProject, ".pi", "settings.json"), "utf8"),
  );
  assert.equal(globalAfter.quietStartup, true);
  assert.deepEqual(globalAfter.apiKeys, globalSettings.apiKeys);
  assert.deepEqual(globalAfter.packages, [globalAmbient, ...roots]);
  assert.deepEqual(
    projectAfter,
    projectSettings,
    "project-local packages must never leak into global settings",
  );
  assert.equal(await readFile(registrarAuthPath, "utf8"), registrarAuthBytes);
  assert.equal((await stat(registrarAuthPath)).mode & 0o777, 0o600);

  const priorKoni = "npm:@koni/core@0.9.0";
  const oldLauncherTarget = path.join(root, "old-koni-launcher");
  await writeFile(
    path.join(registrarAgent, "settings.json"),
    `${JSON.stringify(
      {
        ...globalSettings,
        packages: [globalAmbient, priorKoni],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(oldLauncherTarget, "old launcher\n");
  await rm(launcher, { force: true });
  await symlink(oldLauncherTarget, launcher);
  const crashSettingsBytes = await readFile(path.join(registrarAgent, "settings.json"), "utf8");
  const settingsCrashJournal = path.join(root, "settings-crash-activation.json");
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [registrar, "activate", settingsCrashJournal, launcher, launcherTarget, ...roots],
      {
        cwd: registrarProject,
        env: {
          ...environment,
          NODE_ENV: "test",
          KONI_TEST_CRASH_AFTER_FSYNC: "settings",
        },
      },
    ),
  );
  assert.equal(
    existsSync(settingsCrashJournal),
    true,
    "the durable journal must precede a settings publication attempt",
  );
  assert.equal(
    await readFile(path.join(registrarAgent, "settings.json"), "utf8"),
    crashSettingsBytes,
    "a killed settings writer must leave the prior live file byte-exact",
  );
  assert.equal(await readFile(registrarAuthPath, "utf8"), registrarAuthBytes);
  await execFileAsync(process.execPath, [registrar, "rollback", settingsCrashJournal, launcher], {
    cwd: registrarProject,
    env: environment,
    timeout: 20_000,
  });
  assert.equal(
    await readFile(path.join(registrarAgent, "settings.json"), "utf8"),
    crashSettingsBytes,
    "pre-publication rollback must not normalize or reorder untouched settings",
  );
  assert.equal(await readlink(launcher), oldLauncherTarget);

  const rollbackJournal = path.join(root, "rollback-activation.json");
  await execFileAsync(
    process.execPath,
    [registrar, "activate", rollbackJournal, launcher, launcherTarget, ...roots],
    { cwd: registrarProject, env: environment },
  );
  await rm(launcher, { force: true });
  await symlink(launcherTarget, launcher);
  await assert.rejects(
    execFileAsync(process.execPath, [registrar, "rollback", rollbackJournal, launcher], {
      cwd: registrarProject,
      env: {
        ...environment,
        NODE_ENV: "test",
        KONI_TEST_CRASH_AFTER_SETTINGS_ROLLBACK: "1",
      },
    }),
  );
  const settingsAfterKilledRollback = JSON.parse(
    await readFile(path.join(registrarAgent, "settings.json"), "utf8"),
  );
  assert.deepEqual(settingsAfterKilledRollback.packages, [globalAmbient, priorKoni]);
  assert.equal(
    await readlink(launcher),
    launcherTarget,
    "the crash fixture must stop between settings rollback and launcher restoration",
  );
  assert.equal(existsSync(rollbackJournal), true);
  await execFileAsync(process.execPath, [registrar, "rollback", rollbackJournal, launcher], {
    cwd: registrarProject,
    env: environment,
    timeout: 20_000,
  });
  const rolledBack = JSON.parse(await readFile(path.join(registrarAgent, "settings.json"), "utf8"));
  assert.deepEqual(rolledBack.packages, [globalAmbient, priorKoni]);
  assert.equal(
    await readlink(launcher),
    oldLauncherTarget,
    "failed activation must restore the prior launcher atomically",
  );

  const corruptRollbackBefore = await readFile(path.join(registrarAgent, "settings.json"), "utf8");
  const corruptRollbackJournal = path.join(root, "corrupt-settings-rollback.json");
  await execFileAsync(
    process.execPath,
    [registrar, "activate", corruptRollbackJournal, launcher, launcherTarget, ...roots],
    { cwd: registrarProject, env: environment },
  );
  await rm(launcher, { force: true });
  await symlink(launcherTarget, launcher);
  await writeFile(
    path.join(registrarAgent, "settings.json"),
    "{ interrupted external Pi write\n",
    "utf8",
  );
  await assert.rejects(
    execFileAsync(process.execPath, [registrar, "rollback", corruptRollbackJournal, launcher], {
      cwd: registrarProject,
      env: environment,
    }),
  );
  assert.equal(
    existsSync(corruptRollbackJournal),
    true,
    "ambiguous malformed settings must keep the recovery journal and launcher snapshot",
  );
  assert.equal(await readlink(launcher), launcherTarget);
  assert.equal(await readFile(registrarAuthPath, "utf8"), registrarAuthBytes);
  await writeFile(path.join(registrarAgent, "settings.json"), corruptRollbackBefore, "utf8");
  await execFileAsync(process.execPath, [registrar, "rollback", corruptRollbackJournal, launcher], {
    cwd: registrarProject,
    env: environment,
  });
  assert.equal(await readlink(launcher), oldLauncherTarget);

  const overlapJournal = path.join(root, "overlap-activation.json");
  let activationSettled = false;
  const overlapActivation = execFileAsync(
    process.execPath,
    [registrar, "activate", overlapJournal, launcher, launcherTarget, ...roots],
    {
      cwd: registrarProject,
      env: {
        ...environment,
        NODE_ENV: "test",
        KONI_TEST_PAUSE_AFTER_JOURNAL_MS: "500",
      },
    },
  ).finally(() => {
    activationSettled = true;
  });
  await waitForExists(overlapJournal);
  assert.equal(
    activationSettled,
    false,
    "the overlap writer must begin while activation holds Pi's settings lock",
  );
  const raceSource = "npm:@koni/core@newer-overlapping-source";
  const sdkURL = pathToFileURL(
    path.join(
      stockPiRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "index.js",
    ),
  ).href;
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
  const overlapWriterPromise = execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", overlappingWriter],
    {
      cwd: registrarProject,
      env: environment,
      timeout: 20_000,
    },
  );
  await overlapActivation;
  await overlapWriterPromise;
  const overlapSettings = JSON.parse(
    await readFile(path.join(registrarAgent, "settings.json"), "utf8"),
  );
  assert.ok(
    overlapSettings.packages.includes(raceSource),
    "the concurrent Pi writer must run after, never be overwritten inside, Koni's activation transaction",
  );
  await assert.rejects(
    execFileAsync(process.execPath, [registrar, "rollback", overlapJournal, launcher], {
      cwd: registrarProject,
      env: environment,
    }),
  );
  overlapSettings.packages = overlapSettings.packages.filter((entry) => entry !== raceSource);
  await writeFile(
    path.join(registrarAgent, "settings.json"),
    `${JSON.stringify(overlapSettings, null, 2)}`,
  );
  await execFileAsync(process.execPath, [registrar, "rollback", overlapJournal, launcher], {
    cwd: registrarProject,
    env: environment,
  });

  const commitConflictJournal = path.join(root, "commit-conflict-activation.json");
  await execFileAsync(
    process.execPath,
    [registrar, "activate", commitConflictJournal, launcher, launcherTarget, ...roots],
    { cwd: registrarProject, env: environment },
  );
  const activatedSettingsBytes = await readFile(path.join(registrarAgent, "settings.json"), "utf8");
  const settingsWithNewerCore = JSON.parse(activatedSettingsBytes);
  settingsWithNewerCore.packages.push("npm:@koni/core@newer-concurrent-source");
  await writeFile(
    path.join(registrarAgent, "settings.json"),
    `${JSON.stringify(settingsWithNewerCore, null, 2)}\n`,
  );
  await rm(launcher, { force: true });
  await symlink(launcherTarget, launcher);
  await assert.rejects(
    execFileAsync(process.execPath, [registrar, "commit", commitConflictJournal, launcher], {
      cwd: registrarProject,
      env: environment,
    }),
  );
  assert.equal(
    existsSync(commitConflictJournal),
    true,
    "commit must retain recovery authority when a newer Koni source wins the settings CAS",
  );
  assert.ok(
    JSON.parse(
      await readFile(path.join(registrarAgent, "settings.json"), "utf8"),
    ).packages.includes("npm:@koni/core@newer-concurrent-source"),
  );
  await writeFile(path.join(registrarAgent, "settings.json"), activatedSettingsBytes, "utf8");
  await execFileAsync(process.execPath, [registrar, "rollback", commitConflictJournal, launcher], {
    cwd: registrarProject,
    env: environment,
  });
  assert.equal(await readlink(launcher), oldLauncherTarget);

  const regularLauncher = path.join(registrarBin, "koni-regular");
  const regularBytes = "#!/bin/sh\necho previous-koni\n";
  await writeFile(regularLauncher, regularBytes, { encoding: "utf8", mode: 0o751 });
  const regularJournal = path.join(root, "regular-activation.json");
  await execFileAsync(
    process.execPath,
    [registrar, "activate", regularJournal, regularLauncher, launcherTarget, ...roots],
    { cwd: registrarProject, env: environment },
  );
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
  await execFileAsync(
    process.execPath,
    [registrar, "activate", impossibleJournal, regularLauncher, launcherTarget, ...roots],
    { cwd: registrarProject, env: environment },
  );
  await rm(regularLauncher, { force: true });
  await symlink(launcherTarget, regularLauncher);
  await rm(`${impossibleJournal}.launcher-backup`, { force: true });
  const settingsBeforeImpossibleRollback = await readFile(
    path.join(registrarAgent, "settings.json"),
    "utf8",
  );
  await assert.rejects(
    execFileAsync(process.execPath, [registrar, "rollback", impossibleJournal, regularLauncher], {
      cwd: registrarProject,
      env: environment,
    }),
  );
  assert.equal(
    await readFile(path.join(registrarAgent, "settings.json"), "utf8"),
    settingsBeforeImpossibleRollback,
    "an unauthenticated rollback snapshot must fail before partially restoring settings",
  );
  assert.equal(await readlink(regularLauncher), launcherTarget);
  assert.equal(
    existsSync(impossibleJournal),
    true,
    "unrecoverable legacy journal must remain for explicit remediation",
  );
  await rm(impossibleJournal, { force: true });

  const orphanJournal = path.join(root, "orphan-activation.json");
  await writeFile(`${orphanJournal}.launcher-backup`, "orphaned by a pre-journal crash\n");
  await execFileAsync(
    process.execPath,
    [registrar, "activate", orphanJournal, regularLauncher, launcherTarget, ...roots],
    { cwd: registrarProject, env: environment },
  );
  await execFileAsync(process.execPath, [registrar, "rollback", orphanJournal, regularLauncher], {
    cwd: registrarProject,
    env: environment,
  });
  assert.equal(
    existsSync(`${orphanJournal}.launcher-backup`),
    false,
    "a pre-journal crash orphan must not block the next activation",
  );

  const malformed = "{ definitely not valid JSON\n";
  await writeFile(path.join(malformedAgent, "settings.json"), malformed);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        registrar,
        "activate",
        path.join(root, "malformed-journal.json"),
        launcher,
        launcherTarget,
        ...roots,
      ],
      {
        cwd: registrarProject,
        env: { ...environment, PI_CODING_AGENT_DIR: malformedAgent },
      },
    ),
  );
  assert.equal(
    await readFile(path.join(malformedAgent, "settings.json"), "utf8"),
    malformed,
    "malformed Pi settings must fail closed without replacement",
  );

  if (process.platform !== "win32") {
    await writeFile(
      path.join(unwritableAgent, "settings.json"),
      `${JSON.stringify(globalSettings)}\n`,
    );
    await chmod(unwritableAgent, 0o500);
    try {
      await assert.rejects(
        execFileAsync(
          process.execPath,
          [
            registrar,
            "activate",
            path.join(root, "unwritable-journal.json"),
            launcher,
            launcherTarget,
            ...roots,
          ],
          {
            cwd: registrarProject,
            env: { ...environment, PI_CODING_AGENT_DIR: unwritableAgent },
          },
        ),
      );
    } finally {
      await chmod(unwritableAgent, 0o700);
    }
    assert.deepEqual(
      JSON.parse(await readFile(path.join(unwritableAgent, "settings.json"), "utf8")),
      globalSettings,
      "unwritable Pi settings must remain unchanged",
    );
  }

  const absentLauncher = path.join(registrarBin, "koni-absent-before-activation");
  const absentJournal = path.join(root, "absent-settings-activation.json");
  await rm(path.join(registrarAgent, "settings.json"), { force: true });
  await execFileAsync(
    process.execPath,
    [registrar, "activate", absentJournal, absentLauncher, launcherTarget, ...roots],
    { cwd: registrarProject, env: environment },
  );
  assert.equal(existsSync(path.join(registrarAgent, "settings.json")), true);
  await execFileAsync(process.execPath, [registrar, "rollback", absentJournal, absentLauncher], {
    cwd: registrarProject,
    env: environment,
  });
  assert.equal(
    existsSync(path.join(registrarAgent, "settings.json")),
    false,
    "rollback must restore an originally absent settings file rather than materializing packages: []",
  );
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
  await writeFile(
    helper,
    `
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
`,
  );
  const setup = await execFileAsync(process.execPath, [helper, "setup"], {
    cwd: project,
    env: environment,
    timeout: 10_000,
  });
  const endpoint = JSON.parse(setup.stdout.trim());
  const racers = [0, 1].map(() =>
    spawn(process.execPath, [helper, "serve"], {
      cwd: project,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
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
    assert.equal(
      JSON.parse(await readFile(endpoint.leasePath, "utf8")).pid,
      winners[0].pid,
      "the surviving lease must belong to the packed winner",
    );
    assert.equal(
      await waitForChildExit(racers[loserIndex], 10_000),
      23,
      "the packed loser must exit with the bounded authority_running status",
    );
    assert.equal(
      existsSync(endpoint.leasePath),
      true,
      "the losing starter must not unlink the winner's authority lease",
    );
    assert.equal(
      existsSync(endpoint.endpoint),
      true,
      "the losing starter must not unlink the winner's listener",
    );
    const ping = await execFileAsync(process.execPath, [helper, "ping"], {
      cwd: project,
      env: environment,
      timeout: 10_000,
    });
    assert.equal(
      JSON.parse(ping.stdout).version,
      version,
      "an installed-Core client must reach the surviving packed authority",
    );
    racers[winnerIndex].kill("SIGTERM");
    assert.equal(await waitForChildExit(racers[winnerIndex], 10_000), 0);
  } finally {
    for (const child of racers) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await Promise.all(
      racers.map((child) =>
        child.exitCode === null ? waitForChildExit(child, 5_000).catch(() => undefined) : undefined,
      ),
    );
  }
}

async function assertPackedProductionAttempt({ coreRoot, project, root, environment, version }) {
  await execFileAsync("git", ["add", "-A"], { cwd: project });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Koni package smoke",
      "-c",
      "user.email=koni-smoke@example.invalid",
      "commit",
      "-q",
      "-m",
      "Initialize packed Koni probe",
    ],
    { cwd: project },
  );
  await execFileAsync("git", ["branch", "-M", "main"], { cwd: project });

  const helper = path.join(root, "packed-production-attempt-probe.mjs");
  const launcherURL = pathToFileURL(path.join(coreRoot, "bin", "koni.js")).href;
  const coreURL = pathToFileURL(path.join(coreRoot, "dist", "index.js")).href;
  await writeFile(
    helper,
    `
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { preparePiRuntime } from ${JSON.stringify(launcherURL)};

await preparePiRuntime();
const {
  AuthorityClient,
  KONI_CORE_API_VERSION,
  launchAuthorityDaemon,
} = await import(${JSON.stringify(coreURL)});
assert.equal(KONI_CORE_API_VERSION, ${JSON.stringify(version)});

const launched = await launchAuthorityDaemon({
  projectRoot: ${JSON.stringify(project)},
  version: KONI_CORE_API_VERSION,
  providerFreeAdmissionProbe: true,
});
let serveFailure;
launched.exited?.then(({ code, signal }) => {
  serveFailure = new Error(
    "packed authority exited before shutdown (code " + String(code) + ", signal " + String(signal) + ")",
  );
}).catch((error) => { serveFailure = error; });
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
  // Stock Pi can spend roughly ten seconds constructing the first production session on a loaded
  // verification host. Keep this probe bounded, but do not race that legitimate startup boundary.
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
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
  assert.equal(transcript.protocol, "koni.pi-transcript-page.v1");
  assert.equal(transcript.session.id, planning.sessionId);
  assert.equal(transcript.snapshot.entryCount, lines.filter((entry) => entry.type !== "session").length);
  assert.match(transcript.snapshot.sha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(transcript.usage.allTokens, "0");
  assert.equal(transcript.diagnostics.length, 0);
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

  const deletion = await client.request("run.deletion.inspect", { runId });
  assert.equal(deletion.result.protocol, "koni.run-deletion-preview.v1");
  assert.match(deletion.result.previewToken, /^sha256:[a-f0-9]{64}$/u);
  await client.request("run.delete", {
    runId,
    mode: "delete_owned_branches",
    previewToken: deletion.result.previewToken,
  }, {
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
  if (launched.pid !== undefined) {
    try { process.kill(launched.pid, "SIGTERM"); } catch { /* already stopped */ }
  }
  if (launched.exited !== undefined) {
    await Promise.race([
      launched.exited,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("packed authority did not stop after SIGTERM")),
        15_000,
      )),
    ]);
  }
}
`,
    "utf8",
  );

  const result = await execFileAsync(process.execPath, [helper], {
    cwd: project,
    env: { ...environment, NODE_ENV: "test" },
    timeout: 90_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.phase, "deleted");
  assert.match(evidence.status, /^(?:aborted|interrupted)$/u);
  assert.equal(evidence.usage, 0);
  assert.match(evidence.specHash, /^sha256:[a-f0-9]{64}$/u);
}

async function assertInstalledStandaloneTui({ coreRoot, project, root, environment, version }) {
  const helper = path.join(root, "packed-standalone-tui-probe.mjs");
  const launcherURL = pathToFileURL(path.join(coreRoot, "bin", "koni.js")).href;
  const coreURL = pathToFileURL(path.join(coreRoot, "dist", "index.js")).href;
  const cliURL = pathToFileURL(path.join(coreRoot, "dist", "cli.js")).href;
  await writeFile(
    helper,
    `
import assert from "node:assert/strict";
import { preparePiRuntime } from ${JSON.stringify(launcherURL)};

await preparePiRuntime();
const {
  KONI_CORE_API_VERSION,
  createStandaloneControlCenter,
  ensureProjectAuthority,
} = await import(${JSON.stringify(coreURL)});
const { runKoniCli } = await import(${JSON.stringify(cliURL)});
assert.equal(KONI_CORE_API_VERSION, ${JSON.stringify(version)});

class MemoryTerminal {
  starts = 0;
  stops = 0;
  writes = [];
  inputs = [];
  input;
  get columns() { return 82; }
  get rows() { return 20; }
  get kittyProtocolActive() { return false; }
  start(onInput) { this.starts += 1; this.input = onInput; }
  stop() { this.stops += 1; }
  async drainInput() {}
  write(value) { this.writes.push(value); }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  send(value) {
    assert.equal(typeof this.input, "function", "the in-memory TUI must bind its input handler");
    this.inputs.push(value);
    this.input(value);
  }
}

let surface;
const output = [];
const code = await runKoniCli([
  "tui", "--root", ${JSON.stringify(project)},
], {
  stdout(value) { output.push(value); },
  stderr(value) { output.push(value); },
  stdinIsTTY: true,
  stdoutIsTTY: true,
}, {
  ensure: ensureProjectAuthority,
  standalone: async (options) => {
    const terminal = new MemoryTerminal();
    const handle = await createStandaloneControlCenter({
      ...options,
      terminal,
      models: [],
    });
    assert.equal(handle.started, false);
    assert.equal(terminal.starts, 0, "construction must not enter even the in-memory terminal");
    const initial = handle.component.renderFrame(82, 20).toPlainLines().join("\\n");
    assert.match(initial, /Runs/u);
    assert.match(initial, /Details:/u);
    assert.match(initial, /Activity/u);
    assert.match(initial, /Agents/u);
    handle.start();
    assert.equal(handle.started, true);
    assert.equal(terminal.starts, 1);
    terminal.send("2");
    terminal.send("5");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const interacted = handle.component.renderFrame(82, 20).toPlainLines().join("\\n");
    assert.match(interacted, /Activity/u);
    terminal.send("q");
    await Promise.race([
      handle.closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("in-memory koni tui did not close")), 5_000)),
    ]);
    assert.equal(terminal.stops, 1);
    assert.ok(terminal.writes.length > 0, "the real packed TUI must render into the in-memory terminal");
    surface = {
      dimensions: [terminal.columns, terminal.rows],
      starts: terminal.starts,
      stops: terminal.stops,
      writes: terminal.writes.length,
      inputs: terminal.inputs,
      initialSha256: (await import("node:crypto")).createHash("sha256").update(initial).digest("hex"),
      interactedSha256: (await import("node:crypto")).createHash("sha256").update(interacted).digest("hex"),
    };
  },
});
assert.equal(code, 0);
assert.deepEqual(output, []);
assert.ok(surface);
process.stdout.write(JSON.stringify(surface));
`,
    "utf8",
  );

  const result = await execFileAsync(process.execPath, [helper], {
    cwd: project,
    env: environment,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const evidence = JSON.parse(result.stdout);
  assert.deepEqual(evidence.dimensions, [82, 20]);
  assert.equal(evidence.starts, 1);
  assert.equal(evidence.stops, 1);
  assert.ok(evidence.writes > 0);
  assert.deepEqual(evidence.inputs, ["2", "5", "q"]);
  assert.match(evidence.initialSha256, /^[a-f0-9]{64}$/u);
  assert.match(evidence.interactedSha256, /^[a-f0-9]{64}$/u);
}

async function startPackedProviderFreeAuthority({ launcher, project, environment }) {
  await execFileAsync(launcher, ["start", "--root", project], {
    cwd: project,
    env: {
      ...environment,
      NODE_ENV: "test",
      KONI_PROVIDER_FREE_RELEASE_PROBE: "1",
    },
    timeout: 75_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function stopPackedAuthority({ launcher, project, environment }) {
  const deadline = Date.now() + 60_000;
  let lastError;
  do {
    try {
      await execFileAsync(launcher, ["stop", "--root", project], {
        cwd: project,
        env: environment,
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return;
    } catch (error) {
      lastError = error;
      const stderr = String(error?.stderr ?? "");
      if (
        !/settling a non-interruptible lifecycle transition; retry restart shortly/iu.test(stderr)
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } while (Date.now() < deadline);
  throw lastError;
}

async function seedPackedActionableRun({ coreRoot, project, root, environment, runId, mode }) {
  const helper = path.join(root, `packed-actionable-seed-${mode}.mjs`);
  const launcherURL = pathToFileURL(path.join(coreRoot, "bin", "koni.js")).href;
  const endpointURL = pathToFileURL(path.join(coreRoot, "dist", "authority", "endpoint.js")).href;
  const storeURL = pathToFileURL(path.join(coreRoot, "dist", "authority", "project-store.js")).href;
  const runURL = pathToFileURL(path.join(coreRoot, "dist", "state", "run-record.js")).href;
  const questionBatchURL = pathToFileURL(
    path.join(coreRoot, "dist", "state", "question-batch.js"),
  ).href;
  const gitURL = pathToFileURL(path.join(coreRoot, "dist", "git", "lifecycle.js")).href;
  const canonicalURL = pathToFileURL(path.join(coreRoot, "dist", "shared", "canonical.js")).href;
  const runProgramURL = pathToFileURL(
    path.join(coreRoot, "dist", "compiler", "run-program.js"),
  ).href;
  const profileSourceURL = pathToFileURL(
    path.join(coreRoot, "dist", "operator", "profile-source.js"),
  ).href;
  const profileInstallURL = pathToFileURL(
    path.join(coreRoot, "dist", "profile", "install.js"),
  ).href;
  await writeFile(
    helper,
    `
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { preparePiRuntime } from ${JSON.stringify(launcherURL)};

await preparePiRuntime();
const { discoverAuthorityEndpoint } = await import(${JSON.stringify(endpointURL)});
const { ProjectAuthorityStore } = await import(${JSON.stringify(storeURL)});
const { assertRunRecord } = await import(${JSON.stringify(runURL)});
const { createQuestionBatch } = await import(${JSON.stringify(questionBatchURL)});
const { IsolatedGitLifecycle } = await import(${JSON.stringify(gitURL)});
const { canonicalHash } = await import(${JSON.stringify(canonicalURL)});
const { NativeRunCompilerProgram } = await import(${JSON.stringify(runProgramURL)});
const { loadCachedInstalledProfile } = await import(${JSON.stringify(profileSourceURL)});
const { loadProfilePackage } = await import(${JSON.stringify(profileInstallURL)});
const exec = promisify(execFile);
const project = ${JSON.stringify(project)};
const runId = ${JSON.stringify(runId)};
const mode = ${JSON.stringify(mode)};
const endpoint = await discoverAuthorityEndpoint(project);
const store = await ProjectAuthorityStore.open({
  stateRoot: endpoint.stateRoot,
  projectRoot: endpoint.identity.worktreeRoot,
  commonDirectory: endpoint.identity.commonDirectory,
});
let prior = await store.getRun(runId);
let draft = structuredClone(prior);
let atMs = Math.max(Date.now(), Date.parse(prior.updatedAt) + 1_000);
let at = new Date(atMs).toISOString();
const stage = (kind, fallback) => draft.pipelineStages?.find((candidate) => candidate.kind === kind)?.id
  ?? draft.pipelineStageIds.find((id) => id.includes(fallback))
  ?? draft.currentPipelineStageId;
const checkpointWrites = [];
const interruptAttempts = () => {
  for (const attempt of Object.values(draft.attempts)) {
    if (attempt.id === draft.planningSession?.attemptId) continue;
    if (["queued", "running", "waiting_question", "terminal_accepted"].includes(attempt.status)) {
      attempt.status = "interrupted";
      attempt.endedAt = at;
      attempt.terminalSummary = "Closed by the package-smoke fixture transition";
      attempt.error = "Closed by the package-smoke fixture transition";
    }
  }
};
const commit = async () => {
  draft.revision = prior.revision + 1;
  draft.updatedAt = at;
  draft.lifecycle.revision += 1;
  draft.activity.push({
    id: "activity-package-" + mode,
    at,
    kind: mode === "merge" ? "git" : "compiler",
    message: "Package smoke prepared " + mode.replaceAll("_", " ") + " operator state",
    ticketId: undefined,
    nodeId: undefined,
  });
  assertRunRecord(draft);
  const state = await store.state();
  await store.commit({
    expectedRevision: state.revision,
    runWrites: [{ record: draft, expectedRevision: prior.revision }],
    ...(checkpointWrites.length === 0 ? {} : { writes: checkpointWrites }),
  });
};

if (mode !== "merge" && draft.planningSession?.status === "blocked") {
  const recovered = structuredClone(prior);
  const planningAttempt = recovered.attempts[recovered.planningSession.attemptId];
  const planningRevision = recovered.planningSession.revisions[recovered.planningSession.currentRevision];
  assert.ok(planningAttempt, "the stopped packaged planner must retain its stable attempt");
  assert.equal(planningRevision?.status, "failed");
  planningAttempt.status = "queued";
  planningAttempt.endedAt = undefined;
  planningAttempt.terminalSummary = undefined;
  delete planningAttempt.error;
  delete planningAttempt.failureCode;
  recovered.planningSession.status = "running";
  planningRevision.status = "running";
  delete planningRevision.completedAt;
  recovered.lifecycle.phase = recovered.lifecycle.resumePhase ?? "planning";
  recovered.lifecycle.resumePhase = undefined;
  recovered.lifecycle.runningIntent = true;
  recovered.lifecycle.activeSinceMs = atMs;
  recovered.lifecycle.blocker = undefined;
  recovered.lifecycle.terminalReason = undefined;
  recovered.lifecycle.revision += 1;
  recovered.revision = prior.revision + 1;
  recovered.updatedAt = at;
  recovered.activity.push({
    id: "activity-package-planner-recovery-" + mode,
    at,
    kind: "compiler",
    message: "Package smoke restored the same planning revision after runtime release",
    ticketId: undefined,
    nodeId: undefined,
  });
  assertRunRecord(recovered);
  const recoveryState = await store.state();
  await store.commit({
    expectedRevision: recoveryState.revision,
    runWrites: [{ record: recovered, expectedRevision: prior.revision }],
  });
  prior = recovered;
  draft = structuredClone(prior);
  atMs += 1_000;
  at = new Date(atMs).toISOString();
}

if (mode === "question") {
  const attempt = Object.values(draft.attempts).find((candidate) => candidate.kind === "planning")
    ?? Object.values(draft.attempts)[0];
  assert.ok(attempt, "the packaged run must retain its admitted planning attempt");
  attempt.status = "waiting_question";
  attempt.endedAt = undefined;
  attempt.terminalSummary = undefined;
  delete attempt.error;
  assert.ok(draft.planningSession, "the packaged run must retain continuous planning authority");
  assert.equal(draft.planningSession.attemptId, attempt.id);
  assert.equal(
    draft.planningSession.revisions[draft.planningSession.currentRevision]?.status,
    "running",
    "the stopped packaged planner must retain its in-progress revision: " +
      JSON.stringify({ session: draft.planningSession, attempt }),
  );
  draft.planningSession.status = "waiting_question";
  const questionId = "question-package-smoke";
  draft.plan = undefined;
  const questionInput = {
    id: questionId,
    prompt: "How should existing notes be handled during this packaged workflow?",
    options: [
      { id: "preserve", label: "Preserve notes", description: "Keep existing notes and carry them into the new structure." },
      { id: "replace", label: "Replace notes", description: "Start with a clean structured note set." },
    ],
    allowsNotes: true,
    impact: "routine",
  };
  draft.questionBatches = {
    ...(draft.questionBatches ?? {}),
    [questionId]: createQuestionBatch({
      id: questionId,
      attemptId: attempt.id,
      planningRevision: draft.planningSession.currentRevision,
      scope: "run",
      questions: [questionInput],
      createdAt: at,
    }),
  };
  draft.questions = {
    [questionId]: {
      id: questionId,
      attemptId: attempt.id,
      scope: "run",
      prompt: questionInput.prompt,
      options: questionInput.options,
      allowsNotes: true,
      batchId: questionId,
      batchPosition: 1,
      batchSize: 1,
      impact: "routine",
      askedAt: at,
      answeredAt: undefined,
      selectedOptionId: undefined,
      notes: undefined,
    },
  };
  draft.lifecycle.phase = "awaiting_questions";
  draft.lifecycle.resumePhase = "planning";
  draft.lifecycle.runningIntent = true;
  draft.lifecycle.activeSinceMs = undefined;
  draft.lifecycle.pendingQuestions = [{
    id: questionId,
    attemptId: attempt.id,
    askedAtMs: atMs,
    answeredAtMs: undefined,
    answer: undefined,
    notes: undefined,
  }];
  draft.lifecycle.blocker = undefined;
  draft.lifecycle.terminalReason = undefined;
  draft.currentPipelineStageId = stage("planning", "plan");
} else if (mode === "plan" || mode === "revised_plan") {
  const question = draft.questions["question-package-smoke"];
  assert.ok(question?.answeredAt, "the real PTY must durably answer the question before plan review");
  assert.equal(question.notes, "Preserve existing notes during the package smoke.");
  interruptAttempts();
  assert.ok(draft.planningSession, "the packaged plan must retain continuous planning authority");
  const revision = draft.planningSession.currentRevision;
  assert.equal(revision, mode === "revised_plan" ? 1 : 0);
  if (mode === "revised_plan") {
    assert.ok(draft.plan?.steeringHistory.some((entry) =>
      entry.instructions === "Keep the rollout additive and preserve notes."),
    "the installed /koni plan review must persist its exact steering instructions");
  }
  draft.plan = {
    revision,
    status: "awaiting_approval",
    full: {
      architecture: "## Architecture\\nUse the installed Koni authority and isolated run worktree.",
      decisions: "## Decisions\\nPreserve existing notes and make the rollout additive.",
      risk: "## Risk\\nKeep provider activation disabled throughout package evidence.",
      verification: "## Verification\\nProve the exact package hosts and explicit Git promotion.",
    },
    concise: {
      architecture: [{ title: "Owned worktree", description: "Build only inside the compiler-owned run checkout." }],
      decisions: [{ title: "Additive rollout", description: "Preserve existing notes during the transition." }],
      risk: [{ title: "Zero provider spend", description: "Keep the packaged authority before activation." }],
      verification: [{ title: "Shared control centers", description: "Exercise Pi and standalone control centers." }],
    },
    graphSeed: {
      rootSpec: { work_kind: "general" },
      nodes: [],
      edges: [],
    },
    steeringHistory: mode === "revised_plan" ? structuredClone(draft.plan?.steeringHistory ?? []) : [],
  };
  const planningAttempt = draft.attempts[draft.planningSession.attemptId];
  assert.ok(planningAttempt?.sessionFile, "the stable packaged planner must retain its Pi session file");
  assert.equal(planningAttempt.sessionId, draft.planningSession.sessionId);
  planningAttempt.status = "waiting_plan_review";
  planningAttempt.endedAt = undefined;
  planningAttempt.terminalSummary = undefined;
  delete planningAttempt.error;
  let transcript = (await readFile(planningAttempt.sessionFile, "utf8"))
    .trimEnd().split("\\n").filter(Boolean).map((line) => JSON.parse(line));
  if (revision > 0 && !transcript.some((entry) => entry.customType === "koni.planning-revision-map")) {
    const launchSpec = JSON.parse(await readFile(path.join(endpoint.stateRoot, "runs", draft.id,
      "attempts", planningAttempt.id, "planning", "revisions", String(revision), "launch-spec.json"), "utf8"));
    const revisionBinding = launchSpec.planningRevision;
    const revisionMap = {
      type: "custom",
      id: randomUUID(),
      parentId: transcript.at(-1)?.id ?? null,
      timestamp: at,
      customType: "koni.planning-revision-map",
      data: {
        protocol: "koni.planning-revision-map.v1",
        specHash: launchSpec.specHash,
        runId: launchSpec.identity.runId,
        attemptId: launchSpec.identity.attemptId,
        sessionId: launchSpec.identity.sessionId,
        grantId: launchSpec.authority.grantId,
        grantHash: launchSpec.authority.grantHash,
        revision: revisionBinding.revision,
        baseRevision: revisionBinding.baseRevision,
        priorCheckpointSha256: revisionBinding.priorCheckpointSha256,
        priorTranscriptSha256: draft.planningSession.revisions[revision - 1].transcriptSha256,
        steeringSha256: revisionBinding.steeringSha256,
        budgetBaseline: revisionBinding.budgetBaseline,
      },
    };
    await appendFile(planningAttempt.sessionFile, JSON.stringify(revisionMap) + "\\n", "utf8");
    transcript = [...transcript, revisionMap];
  }
  const artifact = {
    full: draft.plan.full,
    concise: draft.plan.concise,
    ...(draft.plan.graphSeed === undefined ? {} : { graphSeed: draft.plan.graphSeed }),
  };
  const checkpointPath = "runs/" + draft.id + "/attempts/" + planningAttempt.id +
    "/planning/revisions/" + revision + "/artifact.json";
  const planningRevision = draft.planningSession.revisions[revision];
  assert.ok(planningRevision, "the active packaged planning revision must exist");
  if (revision === 0) {
    const cached = await loadCachedInstalledProfile(endpoint.identity.worktreeRoot);
    const baseline = await loadProfilePackage(cached.packageRoot);
    const compiler = await NativeRunCompilerProgram.create({
      projectRoot: endpoint.identity.worktreeRoot,
      packageBaseline: baseline,
    });
    const compiled = await compiler.compilePlanningOutput({
      run: draft,
      attemptId: planningAttempt.id,
      output: artifact,
    });
    draft.graphHash = compiled.graphHash;
    draft.graphRevision = compiled.graphRevision;
    if (compiled.tickets !== undefined) draft.tickets = structuredClone(compiled.tickets);
    checkpointWrites.push(...(compiled.artifactWrites ?? []));
  }
  assert.ok(draft.graphHash, "the packaged checkpoint must retain the native compiler graph hash");
  planningRevision.status = "awaiting_review";
  planningRevision.artifactSha256 = canonicalHash(artifact);
  planningRevision.graphSha256 = draft.graphHash;
  planningRevision.transcriptSha256 = canonicalHash({ header: transcript[0], entries: transcript.slice(1) });
  planningRevision.checkpointPath = checkpointPath;
  planningRevision.completedAt = at;
  if (revision > 0) planningRevision.patchSha256 = canonicalHash({ revision, artifact });
  draft.planningSession.status = "awaiting_review";
  checkpointWrites.push({
    path: checkpointPath,
    bytes: Buffer.from(JSON.stringify(artifact) + "\\n", "utf8"),
    expectedSha256: null,
  });
  draft.lifecycle.phase = "awaiting_approval";
  draft.lifecycle.resumePhase = undefined;
  draft.lifecycle.runningIntent = true;
  draft.lifecycle.activeSinceMs = undefined;
  draft.lifecycle.planRevision = revision;
  draft.lifecycle.blocker = undefined;
  draft.lifecycle.terminalReason = undefined;
  draft.currentPipelineStageId = stage("approval", "approval");
} else if (mode === "merge") {
  interruptAttempts();
  assert.equal(draft.git.run.status, "ready", "plan approval must materialize the real run worktree");
  if (draft.planningSession?.status === "approving") {
    const planningAttempt = draft.attempts[draft.planningSession.attemptId];
    const planningRevision = draft.planningSession.revisions[draft.planningSession.currentRevision];
    assert.ok(planningAttempt && planningRevision?.status === "awaiting_review");
    draft.planningSession.status = "approved";
    draft.planningSession.approvedRevision = draft.planningSession.currentRevision;
    planningRevision.status = "approved";
    planningAttempt.status = "completed";
    planningAttempt.endedAt = at;
    planningAttempt.terminalSummary = "Latest validated planning checkpoint approved by package fixture";
  }
  const artifact = path.join(draft.git.run.worktree, "package-smoke-merged.txt");
  await writeFile(artifact, "merged only after explicit operator authorization\\n", "utf8");
  await exec("git", ["add", "package-smoke-merged.txt"], { cwd: draft.git.run.worktree });
  await exec("git", ["-c", "user.name=Koni Package Smoke", "-c", "user.email=koni-package@example.invalid",
    "commit", "-m", "package smoke candidate"], { cwd: draft.git.run.worktree });
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: draft.git.run.worktree })).stdout.trim();
  draft.git.run.headOid = head;
  const lifecycle = new IsolatedGitLifecycle(project);
  const journal = {
    async prepare() {},
    async settle() {},
    async supersedeWithCompensation() { throw new Error("package smoke did not authorize compensation"); },
  };
  const synchronized = await lifecycle.synchronizeTargetIntoRun(draft.git, {
    subject: "Synchronize packaged run target",
  }, journal);
  assert.equal(synchronized.status, "synchronized");
  const prepared = await lifecycle.prepareTargetPromotion(synchronized.lifecycle, {
    subject: "Publish packaged run candidate",
  });
  assert.equal(prepared.preparation.status, "ready");
  draft.git = prepared.lifecycle;
  if (draft.plan !== undefined) draft.plan.status = "approved";
  draft.lifecycle.phase = "merge_ready";
  draft.lifecycle.resumePhase = undefined;
  draft.lifecycle.runningIntent = true;
  draft.lifecycle.activeSinceMs = undefined;
  draft.lifecycle.blocker = undefined;
  draft.lifecycle.terminalReason = undefined;
  draft.currentPipelineStageId = stage("promotion", "promotion");
} else {
  throw new Error("unknown actionable package-smoke mode: " + mode);
}

await commit();
process.stdout.write(JSON.stringify({ mode, runId, phase: draft.lifecycle.phase }));
`,
    "utf8",
  );

  const result = await execFileAsync(process.execPath, [helper], {
    cwd: project,
    env: { ...environment, NODE_ENV: "test" },
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.mode, mode);
  assert.equal(evidence.runId, runId);
}

async function assertInstalledPiPlanHandler({
  stockPiRoot,
  coreRoot,
  agent,
  project,
  root,
  environment,
  runId,
  action,
}) {
  const helper = path.join(root, `installed-pi-plan-${action}.mjs`);
  const sdkURL = pathToFileURL(
    path.join(
      stockPiRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "index.js",
    ),
  ).href;
  const launcherURL = pathToFileURL(path.join(coreRoot, "bin", "koni.js")).href;
  const coreURL = pathToFileURL(path.join(coreRoot, "dist", "index.js")).href;
  await writeFile(
    helper,
    `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { preparePiRuntime } from ${JSON.stringify(launcherURL)};
await preparePiRuntime();
const { AuthorityClient, KONI_CORE_API_VERSION } = await import(${JSON.stringify(coreURL)});
const {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = await import(${JSON.stringify(sdkURL)});
const project = ${JSON.stringify(project)};
const agent = ${JSON.stringify(agent)};
const runId = ${JSON.stringify(runId)};
const action = ${JSON.stringify(action)};
const authority = await AuthorityClient.connect({
  projectRoot: project,
  client: "cli",
  version: KONI_CORE_API_VERSION,
  connectTimeoutMs: 5_000,
});
const settingsManager = SettingsManager.create(project, agent, { projectTrusted: true });
const resourceLoader = new DefaultResourceLoader({ cwd: project, agentDir: agent, settingsManager });
await resourceLoader.reload({ resolveProjectTrust: async () => true });
const modelRuntime = await ModelRuntime.create({
  authPath: ${JSON.stringify(path.join(root, "isolated-command-harness-auth.json"))},
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
assert.deepEqual(extensionsResult.errors ?? [], []);
const theme = {
  fg(_color, value) { return value; },
  bg(_color, value) { return value; },
  bold(value) { return value; },
  italic(value) { return value; },
  underline(value) { return value; },
  inverse(value) { return value; },
};
const fakeTui = { terminal: { columns: 122, rows: 40 }, requestRender() {} };
const waitFor = async (read, label) => {
  for (let attempt = 0; attempt < 6_000; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const diagnostic = await authority.request("run.get", { runId }).then((response) => response.result)
    .catch((error) => ({ diagnosticError: String(error) }));
  throw new Error(label + " did not become observable: " + JSON.stringify({
    lifecycle: diagnostic.lifecycle,
    planningSession: diagnostic.planningSession,
    plan: diagnostic.plan,
    recentActivity: diagnostic.activity?.slice(-4),
  }));
};
let evidence;
const ui = {
  async select() { return undefined; }, async confirm() { return false; }, async input() { return undefined; },
  notify(message, type) { if (type === "error") throw new Error(message); },
  onTerminalInput() { return () => {}; }, setStatus() {}, setWorkingMessage() {}, setWorkingVisible() {},
  setWorkingIndicator() {}, setHiddenThinkingLabel() {}, setWidget() {}, setFooter() {}, setHeader() {}, setTitle() {},
  async custom(factory, _options) {
    let completed = false;
    const component = await factory(fakeTui, theme, {}, () => { completed = true; });
    assert.equal(component.constructor.name, "ControlCenterComponent");
    const frame = component.renderFrame(122, 40).toPlainLines().join("\\n");
    assert.match(frame, /Review plan/u);
    for (const section of ["Architecture", "Decisions", "Risk", "Verification"]) assert.match(frame, new RegExp(section, "u"));
    assert.match(frame, /Owned worktree/u);
    assert.match(frame, /Build only inside the compiler-owned run checkout/u);
    assert.match(frame, /Approve run/u);
    if (action === "revise") {
      const instructions = "Keep the rollout additive and preserve notes.";
      component.handleInput("\\t");
      component.handleInput(instructions);
      assert.match(component.renderFrame(122, 40).toPlainLines().join("\\n"), /Revise plan/u);
      await authority.request("plan.revise", { runId, instructions }, {
        expectedRevision: authority.revision,
        idempotencyKey: "package-smoke-plan-revise",
      });
      const run = await waitFor(async () => {
        const candidate = (await authority.request("run.get", { runId })).result;
        return candidate.plan?.steeringHistory?.some((entry) =>
          entry.instructions === instructions) ? candidate : undefined;
      }, "installed /koni plan revision");
      assert.equal(run.lifecycle.phase, "planning");
      evidence = { action, frame: frame.length, phase: run.lifecycle.phase };
    } else {
      await authority.request("plan.approve", { runId }, {
        expectedRevision: authority.revision,
        idempotencyKey: "package-smoke-plan-approve",
      });
      const run = await waitFor(async () => {
        const candidate = (await authority.request("run.get", { runId })).result;
        const approved = candidate.lifecycle.approvedAtMs !== undefined &&
          candidate.git.run.status === "ready" &&
          candidate.plan?.status === "approved" &&
          candidate.planningSession?.status === "approved";
        const knownConfiguredActionBlock = candidate.lifecycle.phase === "blocked" &&
          candidate.git.run.status === "ready" &&
          /Configured approved_plan_compile action required recovery/u.test(candidate.lifecycle.blocker ?? "");
        return approved || knownConfiguredActionBlock
          ? candidate : undefined;
      }, "installed /koni plan approval and run-worktree materialization");
      assert.notEqual(run.lifecycle.phase, "awaiting_approval");
      evidence = { action, frame: frame.length, phase: run.lifecycle.phase };
    }
    completed = true;
    component.dispose?.();
    return undefined;
  },
  pasteToEditor() {}, setEditorText() {}, getEditorText() { return ""; }, async editor() { return undefined; },
  addAutocompleteProvider() {}, setEditorComponent() {}, getEditorComponent() { return undefined; }, theme,
  getAllThemes() { return []; }, getTheme() { return undefined; }, setTheme() { return { success: true }; },
  getToolsExpanded() { return false; }, setToolsExpanded() {},
};
const runner = session.extensionRunner;
runner.setUIContext(ui, "tui");
const command = runner.getCommand("koni");
assert.ok(command?.sourceInfo.path.startsWith(${JSON.stringify(coreRoot)}));
try {
  await command.handler("", runner.createCommandContext());
  assert.ok(evidence);
} finally {
  await runner.emit({ type: "session_shutdown" });
  session.dispose();
  authority.close();
}
process.stdout.write(JSON.stringify(evidence));
`,
    "utf8",
  );
  const result = await execFileAsync(process.execPath, [helper], {
    cwd: project,
    env: { ...environment, NODE_ENV: "test" },
    timeout: 90_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.action, action);
  assert.ok(evidence.frame > 0);
}

async function assertPackedActionableRunSettled({ coreRoot, project, root, environment, runId }) {
  const helper = path.join(root, "packed-actionable-settled.mjs");
  const launcherURL = pathToFileURL(path.join(coreRoot, "bin", "koni.js")).href;
  const endpointURL = pathToFileURL(path.join(coreRoot, "dist", "authority", "endpoint.js")).href;
  const storeURL = pathToFileURL(path.join(coreRoot, "dist", "authority", "project-store.js")).href;
  const canonicalURL = pathToFileURL(path.join(coreRoot, "dist", "shared", "canonical.js")).href;
  await writeFile(
    helper,
    `
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { preparePiRuntime } from ${JSON.stringify(launcherURL)};
await preparePiRuntime();
const { discoverAuthorityEndpoint } = await import(${JSON.stringify(endpointURL)});
const { ProjectAuthorityStore } = await import(${JSON.stringify(storeURL)});
const { canonicalHash } = await import(${JSON.stringify(canonicalURL)});
const exec = promisify(execFile);
const project = ${JSON.stringify(project)};
const endpoint = await discoverAuthorityEndpoint(project);
const store = await ProjectAuthorityStore.open({
  stateRoot: endpoint.stateRoot,
  projectRoot: endpoint.identity.worktreeRoot,
  commonDirectory: endpoint.identity.commonDirectory,
});
const run = await store.getRun(${JSON.stringify(runId)});
assert.equal(run.lifecycle.phase, "completed");
const question = run.questions["question-package-smoke"];
assert.equal(question?.selectedOptionId, "preserve");
assert.equal(question?.notes, "Preserve existing notes during the package smoke.");
assert.ok(run.plan?.steeringHistory.some((entry) =>
  entry.instructions === "Keep the rollout additive and preserve notes."));
assert.equal(run.plan.steeringHistory.length, 1);
const planningAttempts = Object.values(run.attempts).filter((attempt) => attempt.kind === "planning");
assert.equal(planningAttempts.length, 1);
const planningAttempt = planningAttempts[0];
const planningSession = run.planningSession;
assert.ok(planningSession);
assert.equal(planningSession.attemptId, planningAttempt.id);
assert.equal(planningSession.sessionId, planningAttempt.sessionId);
assert.equal(planningSession.currentRevision, 1);
assert.equal(planningSession.approvedRevision, 1);
assert.equal(planningSession.revisions.length, 2);
assert.deepEqual(planningSession.revisions.map((revision) => revision.revision), [0, 1]);
assert.deepEqual(planningSession.revisions.map((revision) => revision.status), ["superseded", "approved"]);
assert.notEqual(planningSession.revisions[0].checkpointPath, planningSession.revisions[1].checkpointPath);
assert.equal(planningSession.revisions[1].artifactSha256, canonicalHash({
  full: run.plan.full,
  concise: run.plan.concise,
  graphSeed: run.plan.graphSeed,
}));
assert.deepEqual(planningSession.revisions[1].budgetBaseline, {
  inputTokens: planningAttempt.inputTokens,
  outputTokens: planningAttempt.outputTokens,
  cacheReadTokens: planningAttempt.cacheReadTokens,
  cacheWriteTokens: planningAttempt.cacheWriteTokens,
});
assert.ok(Array.isArray(planningAttempt.authorityProviderRequests));
for (const revision of planningSession.revisions) {
  assert.equal(existsSync(path.join(endpoint.stateRoot, revision.checkpointPath)), true);
  const launchSpecPath = revision.revision === 0
    ? path.join(endpoint.stateRoot, "runs", run.id, "attempts", planningAttempt.id, "launch-spec.json")
    : path.join(endpoint.stateRoot, "runs", run.id, "attempts", planningAttempt.id,
        "planning", "revisions", String(revision.revision), "launch-spec.json");
  assert.equal(existsSync(launchSpecPath), true);
}
const transcript = (await readFile(planningAttempt.sessionFile, "utf8"))
  .trimEnd().split("\\n").filter(Boolean).map((line) => JSON.parse(line));
assert.equal(transcript.filter((entry) => entry.type === "session").length, 1);
assert.equal(transcript.find((entry) => entry.type === "session")?.id, planningSession.sessionId);
assert.equal(transcript.filter((entry) => entry.customType === "koni.attempt-session-map").length, 1);
assert.equal(transcript.filter((entry) => entry.customType === "koni.planning-revision-map").length, 1);
assert.equal(transcript.filter((entry) => entry.customType === "koni.conversation-fork-map").length, 0);
const messages = Object.values(run.attempts).flatMap((attempt) => attempt.authorityMessages ?? []);
assert.deepEqual(messages.slice(0, 2).map((message) => message.mode), ["steer", "follow_up"]);
const merged = (await exec("git", ["show", run.git.target.ref + ":package-smoke-merged.txt"], {
  cwd: project,
})).stdout;
assert.equal(merged, "merged only after explicit operator authorization\\n");
const usage = Object.values(run.attempts).reduce((total, attempt) => total + attempt.inputTokens +
  attempt.outputTokens + attempt.cacheReadTokens + attempt.cacheWriteTokens, 0);
assert.equal(usage, 0);
process.stdout.write(JSON.stringify({ phase: run.lifecycle.phase, messages: messages.length, usage }));
`,
    "utf8",
  );
  const result = await execFileAsync(process.execPath, [helper], {
    cwd: project,
    env: { ...environment, NODE_ENV: "test" },
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.phase, "completed");
  assert.equal(evidence.messages >= 2, true);
  assert.equal(evidence.usage, 0);
}

async function assertInstalledStandaloneTuiInRealPty({
  launcher,
  project,
  root,
  environment,
  objective,
  action = "observe",
}) {
  if (process.platform === "win32") {
    throw new Error("the frozen release rehearsal requires a real POSIX pseudo-terminal");
  }
  const wrapper = path.join(root, "packed-koni-real-pty.py");
  await writeFile(
    wrapper,
    `#!/usr/bin/env python3
import errno
import fcntl
import os
import pty
import select
import struct
import sys
import termios

launcher = os.environ["KONI_SMOKE_PTY_LAUNCHER"]
project = os.environ["KONI_SMOKE_PTY_PROJECT"]
pid, master = pty.fork()
if pid == 0:
    os.execve(launcher, [launcher, "tui", "--root", project], os.environ)

fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 122, 0, 0))
stdin_fd = sys.stdin.fileno()
stdout_fd = sys.stdout.fileno()
while True:
    readers = [master] + ([] if stdin_fd is None else [stdin_fd])
    ready, _, _ = select.select(readers, [], [], 0.1)
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not data:
            break
        os.write(stdout_fd, data)
    if stdin_fd is not None and stdin_fd in ready:
        data = os.read(stdin_fd, 65536)
        if data:
            os.write(master, data)
        else:
            stdin_fd = None

_, status = os.waitpid(pid, 0)
if os.WIFEXITED(status):
    raise SystemExit(os.WEXITSTATUS(status))
if os.WIFSIGNALED(status):
    raise SystemExit(128 + os.WTERMSIG(status))
raise SystemExit(1)
`,
    "utf8",
  );
  await chmod(wrapper, 0o700);

  // The relay's stdin/stdout remain ordinary test pipes. Only the forked packed Koni process gets
  // a real local PTY, fixed to the same ordinary 122x40 surface used by the semantic frame contract.
  const child = spawn("python3", [wrapper], {
    cwd: project,
    env: {
      ...environment,
      TERM: "xterm-256color",
      COLUMNS: "122",
      LINES: "40",
      KONI_SMOKE_PTY_LAUNCHER: launcher,
      KONI_SMOKE_PTY_PROJECT: project,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const populated = await waitForOutput(
      () => stripTerminalControls(`${stdout}\n${stderr}`),
      /Activity/u,
      30_000,
    );
    assert.match(populated, new RegExp(escapeRegExp(objective), "u"));
    assert.match(populated, /Runs/u);
    assert.match(populated, /Details:/u);
    assert.match(populated, /Activity/u);
    assert.match(populated, /Agents/u);
    if (action !== "merge") assert.match(populated, /Planning|planning|Questions/u);
    assert.match(populated, /\b0 new\b|Tokens\s+0 (?:new|fresh)/u);
    if (action === "answer_question") {
      assert.match(populated, /Questions/u);
      await writePtyInputs(child, ["?"]);
      const question = await waitForOutput(
        () => stripTerminalControls(`${stdout}\n${stderr}`),
        /Submit answer/u,
        15_000,
      );
      assert.match(question, /None of the above/u);
      assert.match(question, /Notes \(optional\)/u);
      await writePtyInputs(child, [
        "\t",
        "Preserve existing notes during the package smoke.",
        "\t",
      ]);
      stdout = "";
      stderr = "";
      await writePtyInputs(child, ["\x1b[13;5u"]);
      await waitForOutput(
        () => stripTerminalControls(`${stdout}\n${stderr}`),
        /\[n\] new/u,
        15_000,
      );
    } else if (action === "merge") {
      await writePtyInputs(child, ["m"]);
      const review = await waitForOutput(
        () => stripTerminalControls(`${stdout}\n${stderr}`),
        /Authorize merge|Keep run separate/u,
        15_000,
      );
      assert.match(review, /Destination/u);
      await writePtyInputs(child, ["j", "\r"]);
      await waitForOutput(
        () => stripTerminalControls(`${stdout}\n${stderr}`),
        /Status(?::|\s)\s*Completed|Published run to target/iu,
        30_000,
      );
    }
    child.stdin.write("q");
    child.stdin.end();
    const exitCode = await Promise.race([
      waitForChildExit(child, 15_000),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`packed koni tui did not exit from its real PTY\n${populated}`)),
          15_000,
        ),
      ),
    ]);
    assert.equal(exitCode, 0, `the packed koni tui PTY wrapper exited ${String(exitCode)}`);
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await waitForChildExit(child, 5_000).catch(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
  }
}

async function assertInstalledPiCommandHandlers({
  stockPiRoot,
  coreRoot,
  agent,
  project,
  root,
  environment,
}) {
  const helper = path.join(root, "installed-pi-command-handler-probe.mjs");
  const sdkURL = pathToFileURL(
    path.join(
      stockPiRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "index.js",
    ),
  ).href;
  const launcherURL = pathToFileURL(path.join(coreRoot, "bin", "koni.js")).href;
  const coreURL = pathToFileURL(path.join(coreRoot, "dist", "index.js")).href;
  await writeFile(
    helper,
    `
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { preparePiRuntime } from ${JSON.stringify(launcherURL)};

await preparePiRuntime();
const {
  AuthorityClient,
  KONI_CORE_API_VERSION,
  launchAuthorityDaemon,
} = await import(${JSON.stringify(coreURL)});
const {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = await import(${JSON.stringify(sdkURL)});

const project = ${JSON.stringify(project)};
const agent = ${JSON.stringify(agent)};
const coreRoot = ${JSON.stringify(coreRoot)};
const objective = "Package smoke background run";
assert.equal(process.env.NODE_ENV, "test");
const launched = await launchAuthorityDaemon({
  projectRoot: project,
  version: KONI_CORE_API_VERSION,
  providerFreeAdmissionProbe: true,
});
let serveFailure;
launched.exited?.then(async ({ code, signal }) => {
  const daemonLog = await readFile(project + "/.git/koni/authority/daemon.log", "utf8")
    .catch(() => "(daemon log unavailable)");
  serveFailure = new Error(
    "provider-free packaged authority exited before shutdown (code " + String(code) +
      ", signal " + String(signal) + ")\\n" + daemonLog,
  );
}).catch((error) => { serveFailure = error; });
let authority;
// AuthorityClient's bounded socket timers are intentionally unref'ed in production. Keep this
// short-lived helper alive while its detached child crosses first startup, then release the handle.
const connectKeepalive = setInterval(() => undefined, 1_000);
try {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (serveFailure) throw serveFailure;
    try {
      authority = await AuthorityClient.connect({
        projectRoot: project,
        client: "cli",
        version: KONI_CORE_API_VERSION,
        connectTimeoutMs: 250,
      });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
} finally {
  clearInterval(connectKeepalive);
}
assert.ok(authority, "packaged provider-free authority never became reachable");

const settingsManager = SettingsManager.create(project, agent, { projectTrusted: true });
const resourceLoader = new DefaultResourceLoader({ cwd: project, agentDir: agent, settingsManager });
await resourceLoader.reload({ resolveProjectTrust: async () => true });
const modelRuntime = await ModelRuntime.create({
  authPath: ${JSON.stringify(path.join(root, "isolated-command-harness-auth.json"))},
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
assert.deepEqual(extensionsResult.errors ?? [], []);

const notifications = [];
const widgets = [];
const statuses = [];
const customKinds = [];
const liveWidgets = new Map();
const frames = {};
let run;
const theme = {
  fg(_color, value) { return value; },
  bg(_color, value) { return value; },
  bold(value) { return value; },
  italic(value) { return value; },
  underline(value) { return value; },
  inverse(value) { return value; },
};
const fakeTui = { terminal: { columns: 100, rows: 40 }, requestRender() {} };
const waitFor = async (read, label) => {
  for (let attempt = 0; attempt < 6_000; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(label + " did not become observable");
};
const waitForAsync = async (read, label) => {
  for (let attempt = 0; attempt < 6_000; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(label + " did not become observable");
};
const ui = {
  async select() { return undefined; },
  async confirm() { return false; },
  async input() { return undefined; },
  notify(message, type) { notifications.push({ message, type }); },
  onTerminalInput() { return () => {}; },
  setStatus(key, text) { statuses.push({ key, text }); },
  setWorkingMessage() {},
  setWorkingVisible() {},
  setWorkingIndicator() {},
  setHiddenThinkingLabel() {},
  setWidget(key, content, options) {
    liveWidgets.get(key)?.dispose?.();
    liveWidgets.delete(key);
    let frame;
    if (typeof content === "function") {
      const component = content(fakeTui, theme);
      frame = component.render(100).join("\\n");
      liveWidgets.set(key, component);
    }
    widgets.push({ key, present: content !== undefined, options, frame });
  },
  setFooter() {},
  setHeader() {},
  setTitle() {},
  async custom(factory, options) {
    let result;
    let completed = false;
    const done = (value) => { result = value; completed = true; };
    const component = await factory(fakeTui, theme, {}, done);
    const kind = component.constructor.name;
    customKinds.push(kind);
    if (kind === "GuidedRunModalComponent") {
      const frame = component.render(100).join("\\n");
      assert.match(frame, /Run type/u);
      assert.match(frame, /Target branch/u);
      frames.guided = frame;
      component.handleInput(objective);
      for (let index = 0; index < 128 && component.state.focus !== "start"; index += 1) {
        component.handleInput("\\t");
      }
      assert.equal(component.state.focus, "start", "the installed modal must expose its explicit Start control");
      assert.equal(component.state.objective, objective,
        "the installed modal must retain the complete objective while focus follows the Start control");
      const ready = component.render(100).join("\\n");
      assert.match(ready, /Start (?:Planning|Work)/u);
      frames.guidedReady = ready;
      component.handleInput("\\r");
      await waitFor(() => {
        const state = component.state;
        if (!state.busy && state.error !== undefined) {
          throw new Error("guided run modal rejected Start: " + state.error);
        }
        return result;
      }, "guided run modal Start");
      assert.equal(result.kind, "started");
      assert.equal(result.state.objective, objective);
    } else if (kind === "RunsOverlayComponent") {
      assert.equal(options?.overlay, true);
      const frame = await waitFor(() => {
        const candidate = component.render(100).join("\\n");
        return candidate.includes(objective) ? candidate : undefined;
      }, "populated runs overlay");
      assert.match(frame, /Koni Runs/u);
      assert.match(frame, /Package smoke background run/u);
      assert.match(frame, /Planning/u);
      assert.match(frame, /1\\/1 agents/u);
      assert.match(frame, /0 new tks/u);
      frames.runs = frame;
      component.handleInput("\\x1b");
      await waitFor(() => result, "runs overlay");
      assert.deepEqual(result, { kind: "close" });
    } else {
      assert.equal(kind, "ControlCenterComponent");
      const initial = component.renderFrame(122, 40).toPlainLines().join("\\n");
      assert.match(initial, /Runs/u);
      assert.match(initial, /Details:/u);
      assert.match(initial, /Activity/u);
      assert.match(initial, /Agents/u);
      assert.match(initial, /Package smoke background run/u);
      assert.match(initial, /Planning|planning/u);
      component.handleInput("3");
      await new Promise((resolve) => setImmediate(resolve));
      component.handleInput("j");
      await new Promise((resolve) => setImmediate(resolve));
      component.handleInput("\\r");
      const selectedAgent = await waitFor(() => {
        const candidate = component.renderFrame(122, 40).toPlainLines().join("\\n");
        return /Chat/u.test(candidate) && /Planning|planner|Lead/u.test(candidate) ? candidate : undefined;
      }, "active packaged agent chat");
      component.handleInput("s");
      await waitFor(() => {
        const candidate = component.renderFrame(122, 40).toPlainLines().join("\\n");
        return candidate.includes("[Ctrl-Enter] send") ? candidate : undefined;
      }, "agent steering composer");
      component.handleInput("Keep the package smoke provider-free.");
      component.handleInput("\\x1b[13;5u");
      await waitForAsync(async () => {
        const current = (await authority.request("run.get", { runId: run.id })).result;
        const messages = Object.values(current.attempts).flatMap((attempt) => attempt.authorityMessages ?? []);
        return messages.some((message) => message.mode === "steer") ? messages : undefined;
      }, "durable agent steering message");
      await waitFor(() => {
        const candidate = component.renderFrame(122, 40).toPlainLines().join("\\n");
        return candidate.includes("[Enter/s] compose") && !candidate.includes("Steering agent…")
          ? candidate : undefined;
      }, "settled agent steering composer");
      component.handleInput("s");
      component.handleInput("\\t");
      component.handleInput("Queue this after the current turn.");
      component.handleInput("\\x1b[13;5u");
      await waitForAsync(async () => {
        const current = (await authority.request("run.get", { runId: run.id })).result;
        const messages = Object.values(current.attempts).flatMap((attempt) => attempt.authorityMessages ?? []);
        return messages.some((message) => message.mode === "follow_up") ? messages : undefined;
      }, "durable agent follow-up message");
      await waitFor(() => {
        const candidate = component.renderFrame(122, 40).toPlainLines().join("\\n");
        return candidate.includes("[Enter/s] compose") && !candidate.includes("Sending follow-up…")
          ? candidate : undefined;
      }, "settled agent follow-up composer");
      frames.chat = selectedAgent;

      component.handleInput("\\x1b");
      component.handleInput("c");
      const configure = await waitFor(() => {
        const candidate = component.renderFrame(122, 40).toPlainLines().join("\\n");
        return candidate.includes("CONFIGURE") && candidate.includes("Domains") &&
          candidate.includes("Run Types") && candidate.includes("Editor") ? candidate : undefined;
      }, "guided configuration surface");
      for (let index = 0; index < 32; index += 1) {
        const candidate = component.renderFrame(122, 40).toPlainLines().join("\\n");
        if (candidate.includes("Default Run Type")) break;
        component.handleInput("]");
      }
      await waitFor(() => {
        const candidate = component.renderFrame(122, 40).toPlainLines().join("\\n");
        return candidate.includes("Default Run Type") ? candidate : undefined;
      }, "guided project configuration domain");
      component.handleInput("j");
      await waitFor(() => {
        const candidate = component.renderFrame(122, 40).toPlainLines().join("\\n");
        return candidate.includes("Evidence-guided vertical software delivery") && candidate.includes("Title")
          ? candidate : undefined;
      }, "guided project identity resource");
      component.handleInput("\\t");
      component.handleInput("j");
      component.handleInput("\\r");
      await waitFor(() => {
        const candidate = component.renderFrame(122, 40).toPlainLines().join("\\n");
        return candidate.includes("Edit Title") ? candidate : undefined;
      }, "guided project-title editor");
      component.handleInput(" Package Smoke");
      component.handleInput("\\x1b[13;5u");
      await waitFor(() => {
        const candidate = component.renderFrame(122, 40).toPlainLines().join("\\n");
        return candidate.includes("Package Smoke") && candidate.includes("unpublished changes")
          ? candidate : undefined;
      }, "guided configuration draft");
      component.handleInput("\\x10");
      const published = await waitFor(() => {
        const candidate = component.renderFrame(122, 40).toPlainLines().join("\\n");
        return candidate.includes("configuration current") && candidate.includes("Package Smoke")
          ? candidate : undefined;
      }, "published guided configuration");
      frames.configure = configure;
      frames.configurePublished = published;
      component.handleInput("\\x1b");

      component.handleInput("2");
      component.handleInput("5");
      await new Promise((resolve) => setTimeout(resolve, 10));
      frames.control = component.renderFrame(122, 40).toPlainLines().join("\\n");
      assert.match(frames.control, /Package smoke background run/u);
      done(undefined);
    }
    if (kind === "ControlCenterComponent") {
      assert.equal(completed, true);
      return undefined;
    }
    component.dispose?.();
    return result;
  },
  pasteToEditor() {},
  setEditorText() {},
  getEditorText() { return ""; },
  async editor() { return undefined; },
  addAutocompleteProvider() {},
  setEditorComponent() {},
  getEditorComponent() { return undefined; },
  theme,
  getAllThemes() { return []; },
  getTheme() { return undefined; },
  setTheme() { return { success: true }; },
  getToolsExpanded() { return false; },
  setToolsExpanded() {},
};

const runner = session.extensionRunner;
runner.setUIContext(ui, "tui");
const context = runner.createCommandContext();
const commands = {};
for (const name of ["koni", "koni-run", "koni-runs"]) {
  const command = runner.getCommand(name);
  assert.ok(command, "installed Pi extension did not resolve /" + name);
  assert.ok(command.sourceInfo.path.startsWith(coreRoot), command.sourceInfo.path);
  assert.equal(command.sourceInfo.scope, "user");
  assert.equal(command.sourceInfo.origin, "package");
  commands[name] = command;
}

try {
  await commands["koni-run"].handler("small", context);
  assert.equal(
    notifications.some((entry) => entry.type === "error"),
    false,
    "installed /koni-run failed: " + JSON.stringify({ notifications, customKinds }),
  );
  assert.deepEqual(customKinds, ["GuidedRunModalComponent"],
    "installed /koni-run must open and submit the real guided modal before durable observation");

  let page;
  let planning;
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    page = (await authority.request("run.page", { limit: 200 })).result;
    const summary = page.runs.find((candidate) => candidate.objectivePreview === objective);
    if (summary !== undefined) {
      run = (await authority.request("run.get", { runId: summary.id })).result;
      planning = Object.values(run.attempts).find((candidate) =>
        candidate.kind === "planning" && typeof candidate.sessionFile === "string");
      if (planning !== undefined) break;
      if (run.lifecycle.phase === "blocked") throw new Error(run.lifecycle.blocker ?? "guided run blocked");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(page.protocol, "koni.run-summary-page.v2");
  assert.ok(run, "the installed /koni-run handler did not create a durable run: " +
    JSON.stringify({ notifications, customKinds, page }));
  assert.ok(planning, "the guided background run did not durably publish its Pi session mapping");
  assert.equal(existsSync(planning.sessionFile), true);
  const transcript = (await readFile(planning.sessionFile, "utf8"))
    .trimEnd().split("\\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(transcript.find((entry) => entry.type === "session")?.id, planning.sessionId);
  const mapping = transcript.find((entry) =>
    entry.type === "custom" && entry.customType === "koni.attempt-session-map");
  assert.equal(mapping?.data?.attemptId, planning.id);
  assert.equal(mapping?.data?.sessionId, planning.sessionId);
  assert.equal(mapping?.data?.specHash, planning.launchSpecHash);
  const usage = Object.values(run.attempts).reduce((total, attempt) => total +
    attempt.inputTokens + attempt.outputTokens + attempt.cacheReadTokens + attempt.cacheWriteTokens, 0);
  assert.equal(usage, 0, "the guided packaged release probe must withhold provider activation");

  frames.companion = await waitFor(() => {
    for (const widget of liveWidgets.values()) {
      const candidate = widget.render(100).join("\\n");
      if (candidate.includes(objective) && /1 run/u.test(candidate)) return candidate;
    }
    return undefined;
  }, "populated passive companion");
  await commands["koni-runs"].handler("", context);
  await commands.koni.handler("", context);
  assert.deepEqual(customKinds, [
    "GuidedRunModalComponent",
    "RunsOverlayComponent",
    "ControlCenterComponent",
  ]);
  assert.equal(notifications.some((entry) => entry.type === "error"), false, JSON.stringify(notifications));
  assert.ok(widgets.some((entry) => entry.present && /Koni/u.test(entry.frame ?? "")),
    "the invoked handlers must mount the installed companion widget");
  assert.ok(statuses.some((entry) => typeof entry.text === "string" && entry.text.includes("Koni")));

  run = (await authority.request("run.get", { runId: run.id })).result;
  const finalUsage = Object.values(run.attempts).reduce((total, attempt) => total +
    attempt.inputTokens + attempt.outputTokens + attempt.cacheReadTokens + attempt.cacheWriteTokens, 0);
  assert.equal(finalUsage, 0);
  const authorityMessages = Object.values(run.attempts)
    .flatMap((attempt) => attempt.authorityMessages ?? []);
  assert.deepEqual(authorityMessages.map((message) => message.mode), ["steer", "follow_up"]);
  const config = (await authority.request("config.get")).result;
  assert.ok(Object.values(config.values).some((value) =>
    typeof value === "string" && value.endsWith(" Package Smoke")), JSON.stringify(config));
  frames.runId = run.id;
  frames.phase = run.lifecycle.phase;
  frames.attempts = Object.keys(run.attempts).length;
  frames.authorityMessages = authorityMessages.length;
} finally {
  await runner.emit({ type: "session_shutdown" });
  session.dispose();
  authority.close();
}
assert.equal(widgets.at(-1)?.present, false);
assert.equal(statuses.at(-1)?.text, undefined);
process.stdout.write(JSON.stringify({
  objective,
  commands: Object.keys(commands).sort(),
  customKinds,
  notifications,
  widgetMounts: widgets.filter((entry) => entry.present).length,
  widgetClears: widgets.filter((entry) => !entry.present).length,
  statusUpdates: statuses.length,
  runId: frames.runId,
  phase: frames.phase,
  attempts: frames.attempts,
  authorityMessages: frames.authorityMessages,
  frames: Object.fromEntries(Object.entries(frames)
    .filter(([, value]) => typeof value === "string")
    .map(([name, value]) => [name, value.length])),
}));
`,
    "utf8",
  );

  const agentBefore = await snapshotTree(agent);
  const result = await execFileAsync(process.execPath, [helper], {
    cwd: project,
    env: { ...environment, NODE_ENV: "test" },
    timeout: 150_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const evidence = JSON.parse(result.stdout);
  assert.deepEqual(evidence.commands, ["koni", "koni-run", "koni-runs"]);
  assert.deepEqual(evidence.customKinds, [
    "GuidedRunModalComponent",
    "RunsOverlayComponent",
    "ControlCenterComponent",
  ]);
  assert.ok(evidence.widgetMounts > 0);
  assert.ok(evidence.widgetClears > 0);
  assert.ok(evidence.statusUpdates > 0);
  assert.ok(evidence.frames.guided > 0);
  assert.ok(evidence.frames.guidedReady > 0);
  assert.ok(evidence.frames.companion > 0);
  assert.ok(evidence.frames.runs > 0);
  assert.ok(evidence.frames.chat > 0);
  assert.ok(evidence.frames.configure > 0);
  assert.ok(evidence.frames.configurePublished > 0);
  assert.ok(evidence.frames.control > 0);
  assert.match(evidence.runId, /^run-[a-f0-9-]+$/u);
  assert.equal(evidence.attempts >= 1, true);
  assert.equal(evidence.authorityMessages, 2);
  assert.notEqual(evidence.phase, "deleted");
  assert.deepEqual(
    await snapshotTree(agent),
    agentBefore,
    "installed Pi command handlers must not alter settings, credentials, packages, or ambient resources",
  );
  return evidence;
}

async function constructAndAbortAgentSession({ stockPiRoot, agent, project, root }) {
  const sdkURL = pathToFileURL(
    path.join(
      stockPiRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "index.js",
    ),
  ).href;
  const {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
  } = await import(sdkURL);
  const settingsManager = SettingsManager.create(project, agent, { projectTrusted: true });
  const resourceLoader = new DefaultResourceLoader({
    cwd: project,
    agentDir: agent,
    settingsManager,
  });
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
    assert.equal(
      extensionsResult.errors?.length ?? 0,
      0,
      JSON.stringify(extensionsResult.errors ?? []),
    );
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
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
    const response = await waitForRpcResponse(
      child,
      () => stdout,
      () => stderr,
      "commands",
    );
    const commands = response.data?.commands ?? [];
    const inventory = JSON.stringify(commands.map(({ name, source }) => ({ name, source })));
    for (const name of ["koni", "koni-run", "koni-runs"]) {
      assert.ok(
        commands.some((command) => command.name === name && command.source === "extension"),
        inventory,
      );
    }
    assert.ok(
      commands.some(
        (command) => command.name === "ambient-extension" && command.source === "extension",
      ),
      inventory,
    );
    assert.ok(
      commands.some((command) => command.name === "skill:ambient-skill"),
      inventory,
    );
    for (const skill of ["configure-koni", "model-koni-work", "operate-koni"]) {
      assert.ok(
        commands.some((command) => command.name === `skill:${skill}` && command.source === "skill"),
        inventory,
      );
    }
    assert.equal(
      existsSync(path.join(project, ".koni")),
      false,
      "extension/session construction must not initialize the project",
    );
    const piStateBeforeOperations = await snapshotTree(agent);

    child.stdin.write(
      `${JSON.stringify({ id: "init", type: "prompt", message: "/koni init coding" })}\n`,
    );
    await waitForRpcResponse(
      child,
      () => stdout,
      () => stderr,
      "init",
    );
    assert.equal(existsSync(path.join(project, ".koni", "project.yaml")), true);
    assert.equal(existsSync(path.join(project, ".koni", ".managed", "install.json")), true);

    child.stdin.write(
      `${JSON.stringify({ id: "config", type: "prompt", message: "/koni config" })}\n`,
    );
    await waitForRpcResponse(
      child,
      () => stdout,
      () => stderr,
      "config",
    );
    assert.deepEqual(
      await snapshotTree(agent),
      piStateBeforeOperations,
      "Koni operations must not alter Pi credentials, settings, packages, or ambient resources",
    );
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
  }
}

async function resolveInstalledPiResources({ stockPiRoot, agent, project, root, environment }) {
  const packageManagerURL = pathToFileURL(
    path.join(
      stockPiRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "core",
      "package-manager.js",
    ),
  ).href;
  const settingsManagerURL = pathToFileURL(
    path.join(
      stockPiRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "core",
      "settings-manager.js",
    ),
  ).href;
  const helper = path.join(root, "resolve-installed-pi-resources.mjs");
  const modelsStorePath = path.join(agent, "models-store.json");
  const modelsStoreBefore = await readFile(modelsStorePath);
  await writeFile(
    helper,
    `
import assert from "node:assert/strict";
import { DefaultPackageManager } from ${JSON.stringify(packageManagerURL)};
import { SettingsManager } from ${JSON.stringify(settingsManagerURL)};

const project = ${JSON.stringify(project)};
const agent = ${JSON.stringify(agent)};
const settingsManager = SettingsManager.create(project, agent, { projectTrusted: true });
const packageManager = new DefaultPackageManager({ cwd: project, agentDir: agent, settingsManager });
assert.deepEqual(
  packageManager.listConfiguredPackages()
    .filter(({ scope }) => scope === "project")
    .map(({ source, scope }) => ({ source, scope })),
  [{ source: ${JSON.stringify(superpowersPackageSource)}, scope: "project" }],
);
const resolved = await packageManager.resolve();
process.stdout.write(JSON.stringify(resolved.skills.map(({ path }) => path).sort()));
`,
    "utf8",
  );
  const result = await execFileAsync(process.execPath, [helper], {
    cwd: project,
    env: { ...environment, NODE_ENV: "test" },
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(
    Buffer.compare(await readFile(modelsStorePath), modelsStoreBefore),
    0,
    "stock Pi package resolution must not initialize or refresh the unrelated model store",
  );
  const clone = path.join(project, ".pi", "git", "github.com", "obra", "superpowers");
  const resolvedSkillPaths = JSON.parse(result.stdout);
  assert.deepEqual(
    resolvedSkillPaths.filter((skillPath) => skillPath.startsWith(`${clone}${path.sep}`)),
    offlineSuperpowersSkillIds.map((id) => path.join(clone, "skills", id, "SKILL.md")),
    "the exact configured package must resolve all and only the required fixture skill paths",
  );
}

async function assertHermeticSuperpowersResolution(project) {
  const clone = path.join(project, ".pi", "git", "github.com", "obra", "superpowers");
  assert.deepEqual(
    JSON.parse(await readFile(path.join(project, ".pi", "settings.json"), "utf8")).packages,
    [superpowersPackageSource],
    "the CLI-initialized project must retain the exact production package identity",
  );
  assert.equal(
    await readFile(path.join(project, ".pi", "git", ".gitignore"), "utf8"),
    "*\n!.gitignore\n",
    "stock Pi must create only its exact project package-cache guard",
  );
  assert.deepEqual(
    (await readdir(path.join(clone, "skills"))).sort(),
    offlineSuperpowersSkillIds,
    "the CLI-initialized project must resolve every required public Superpowers skill",
  );
  assert.equal(
    (await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: clone })).stdout.trim(),
    superpowersCloneUrl,
    "the sealed local transport must preserve the production package origin",
  );
}

async function assertLegacyDuplicateCoreIsInert({ pi, agent, root, environment }) {
  const project = path.join(root, "duplicate-core-project");
  const legacyPackage = path.join(root, "legacy-core-package");
  const marker = path.join(project, "legacy-command-ran");
  await Promise.all([mkdir(path.join(project, ".pi"), { recursive: true }), mkdir(legacyPackage)]);
  await execFileAsync("git", ["init", "-q"], { cwd: project });
  await writeFile(
    path.join(legacyPackage, "package.json"),
    `${JSON.stringify(
      {
        name: "legacy-koni-core-fixture",
        version: "0.0.1",
        type: "module",
        pi: { extensions: ["./extension.js"] },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(legacyPackage, "extension.js"),
    `
import { writeFile } from "node:fs/promises";
export default function legacyKoniCore(pi) {
  pi.registerCommand("koni", {
    description: "Guard-unaware legacy Koni fixture",
    handler: async () => { await writeFile(${JSON.stringify(marker)}, "unsafe legacy handler ran\\n"); },
  });
}
`,
  );
  const projectSettingsPath = path.join(project, ".pi", "settings.json");
  const projectSettingsBytes = `${JSON.stringify(
    {
      packages: [legacyPackage],
      prompts: [path.join(project, "unrelated-project-prompt.md")],
    },
    null,
    2,
  )}\n`;
  await writeFile(path.join(project, "unrelated-project-prompt.md"), "Unrelated project prompt.\n");
  await writeFile(projectSettingsPath, projectSettingsBytes);
  const agentBefore = await snapshotTree(agent);
  const child = spawn(pi, ["--mode", "rpc", "--no-session", "--approve"], {
    cwd: project,
    env: { ...environment, NODE_ENV: "test" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const childClosed = new Promise((resolve) => {
    child.once("close", resolve);
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    child.stdin.write(
      `${JSON.stringify({ id: "duplicate-commands-one", type: "get_commands" })}\n`,
    );
    const first = await waitForRpcResponse(
      child,
      () => stdout,
      () => stderr,
      "duplicate-commands-one",
    );
    const duplicateCommands = (first.data?.commands ?? []).filter(
      (command) =>
        command.source === "extension" && /^(?:koni|koni:[1-9][0-9]*)$/u.test(command.name),
    );
    assert.ok(duplicateCommands.length > 1, JSON.stringify(first.data?.commands ?? []));

    const output = await waitForOutput(
      () => `${stdout}\n${stderr}`,
      /Multiple @koni\/core origins are loaded/u,
      5_000,
    );
    assert.match(output, /Ordinary Pi use remains available/u);
    assert.match(output, /Koni commands are disabled/u);
    assert.match(output, /Pi renamed \/koni/u);
    assert.match(
      output,
      new RegExp(`pi remove .*${escapeRegExp(legacyPackage)}.* --local`, "u"),
      "duplicate remediation must name the exact project-local source and scope",
    );
    assert.equal(
      child.exitCode,
      null,
      "duplicate Koni origins must not shut down an ordinary Pi session",
    );

    // A second ordinary Pi request proves the warning did not strand or terminate the session.
    child.stdin.write(
      `${JSON.stringify({ id: "duplicate-commands-two", type: "get_commands" })}\n`,
    );
    await waitForRpcResponse(
      child,
      () => stdout,
      () => stderr,
      "duplicate-commands-two",
    );
    assert.equal(child.exitCode, null);
    assert.equal(
      existsSync(marker),
      false,
      "duplicate discovery must never invoke a legacy Koni command",
    );
    assert.equal(
      await readFile(projectSettingsPath, "utf8"),
      projectSettingsBytes,
      "duplicate detection must not remove or rewrite project resources itself",
    );
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    // `exit` can precede stdio closure when a child-owned descendant still has inherited handles.
    // Await `close` so the ambient-state assertion observes the whole process lifetime rather than
    // racing a delayed Pi/Koni writer after its direct parent has exited.
    await childClosed;
  }
  assert.deepEqual(
    await snapshotTree(agent),
    agentBefore,
    "duplicate detection and Pi shutdown must preserve global credentials, settings, models, and unrelated resources",
  );
}

async function writePtyInputs(child, inputs) {
  for (const input of inputs) {
    child.stdin.write(input);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function waitForOutput(readOutput, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = readOutput();
    if (pattern.test(output)) return output;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Pi output did not match ${pattern}:\n${readOutput()}`);
}

async function snapshotAmbient(agent, ambientPackage) {
  const authPath = path.join(agent, "auth.json");
  const modelsStorePath = path.join(agent, "models-store.json");
  const settingsPath = path.join(agent, "settings.json");
  const promptPath = path.join(agent, "ambient-prompt.md");
  return {
    ambientPackage: await snapshotTree(ambientPackage),
    ambientPackageModes: await snapshotTreeModes(ambientPackage),
    prompt: await readFile(promptPath, "base64"),
    promptMode: (await stat(promptPath)).mode & 0o777,
    auth: await readFile(authPath, "base64"),
    authMode: (await stat(authPath)).mode & 0o777,
    modelsStore: await readFile(modelsStorePath, "base64"),
    modelsStoreMode: (await stat(modelsStorePath)).mode & 0o777,
    settings: JSON.parse(await readFile(settingsPath, "utf8")),
    settingsBytes: await readFile(settingsPath, "base64"),
    settingsMode: (await stat(settingsPath)).mode & 0o777,
  };
}

async function assertAmbientPreserved(agent, ambientPackage, before, archives) {
  assert.deepEqual(await snapshotTree(ambientPackage), before.ambientPackage);
  assert.deepEqual(
    await snapshotTreeModes(ambientPackage),
    before.ambientPackageModes,
    "Koni package/install/runtime operations must preserve unrelated package, extension, and skill permissions",
  );
  assert.equal(await readFile(path.join(agent, "ambient-prompt.md"), "base64"), before.prompt);
  assert.equal(
    (await stat(path.join(agent, "ambient-prompt.md"))).mode & 0o777,
    before.promptMode,
    "Koni package/install/runtime operations must preserve unrelated prompt permissions",
  );
  assert.equal(
    await readFile(path.join(agent, "auth.json"), "base64"),
    before.auth,
    "Koni package/install/runtime operations must preserve Pi credential bytes exactly",
  );
  assert.equal(
    (await stat(path.join(agent, "auth.json"))).mode & 0o777,
    before.authMode,
    "Koni must preserve Pi credential permissions exactly",
  );
  assert.equal(
    await readFile(path.join(agent, "models-store.json"), "base64"),
    before.modelsStore,
    "Koni must preserve Pi's unrelated offline model store bytes exactly",
  );
  assert.equal(
    (await stat(path.join(agent, "models-store.json"))).mode & 0o777,
    before.modelsStoreMode,
    "Koni must preserve Pi's unrelated offline model store permissions exactly",
  );
  const after = JSON.parse(await readFile(path.join(agent, "settings.json"), "utf8"));
  assert.equal(after.quietStartup, before.settings.quietStartup);
  assert.equal(after.enableAnalytics, before.settings.enableAnalytics);
  assert.deepEqual(after.npmCommand, before.settings.npmCommand);
  assert.deepEqual(after.prompts, before.settings.prompts);
  assert.ok(after.packages.includes(ambientPackage));
  for (const [name, value] of archives)
    assert.ok(after.packages.includes(`npm:${name}@${value.version}`));
}

async function uninstallKoniPackages({
  pi,
  project,
  agent,
  ambientPackage,
  ambientBefore,
  archives,
  environment,
}) {
  for (const [name, value] of [...archives].reverse()) {
    await execFileAsync(pi, ["remove", `npm:${name}@${value.version}`], {
      cwd: project,
      env: environment,
      timeout: 30_000,
    });
  }

  const managedRoot = path.join(agent, "npm", "node_modules");
  for (const name of archives.keys()) {
    assert.equal(
      existsSync(path.join(managedRoot, ...name.split("/"))),
      false,
      `Pi uninstall must remove ${name} from its managed package closure`,
    );
  }
  assert.deepEqual(
    await snapshotTree(ambientPackage),
    ambientBefore.ambientPackage,
    "uninstall must preserve every unrelated package/extension/skill byte",
  );
  assert.deepEqual(
    await snapshotTreeModes(ambientPackage),
    ambientBefore.ambientPackageModes,
    "uninstall must preserve every unrelated package/extension/skill permission",
  );
  const promptPath = path.join(agent, "ambient-prompt.md");
  assert.equal(
    await readFile(promptPath, "base64"),
    ambientBefore.prompt,
    "uninstall must preserve unrelated prompt bytes",
  );
  assert.equal(
    (await stat(promptPath)).mode & 0o777,
    ambientBefore.promptMode,
    "uninstall must preserve unrelated prompt permissions",
  );
  const authPath = path.join(agent, "auth.json");
  assert.equal(
    await readFile(authPath, "base64"),
    ambientBefore.auth,
    "uninstall must preserve credential bytes exactly",
  );
  assert.equal(
    (await stat(authPath)).mode & 0o777,
    ambientBefore.authMode,
    "uninstall must preserve credential permissions exactly",
  );
  const modelsStorePath = path.join(agent, "models-store.json");
  assert.equal(
    await readFile(modelsStorePath, "base64"),
    ambientBefore.modelsStore,
    "uninstall must preserve Pi's unrelated offline model store bytes exactly",
  );
  assert.equal(
    (await stat(modelsStorePath)).mode & 0o777,
    ambientBefore.modelsStoreMode,
    "uninstall must preserve Pi's unrelated offline model store permissions exactly",
  );
  const settingsPath = path.join(agent, "settings.json");
  assert.equal(
    await readFile(settingsPath, "base64"),
    ambientBefore.settingsBytes,
    "installing and removing exactly the three Koni archives must restore unrelated Pi settings byte-for-byte",
  );
  assert.equal(
    (await stat(settingsPath)).mode & 0o777,
    ambientBefore.settingsMode,
    "install/uninstall must preserve Pi settings permissions",
  );

  const child = spawn(pi, ["--mode", "rpc", "--no-session"], {
    cwd: project,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    child.stdin.write(
      `${JSON.stringify({ id: "post-uninstall-commands", type: "get_commands" })}\n`,
    );
    const response = await waitForRpcResponse(
      child,
      () => stdout,
      () => stderr,
      "post-uninstall-commands",
    );
    const commands = response.data?.commands ?? [];
    assert.ok(
      commands.some(
        (command) => command.name === "ambient-extension" && command.source === "extension",
      ),
    );
    assert.ok(
      commands.some(
        (command) => command.name === "skill:ambient-skill" && command.source === "skill",
      ),
    );
    for (const name of ["koni", "koni-run", "koni-runs"]) {
      assert.equal(
        commands.some((command) => command.name === name && command.source === "extension"),
        false,
        `/${name} must disappear only after @koni/core is explicitly uninstalled`,
      );
    }
    for (const skill of ["configure-koni", "model-koni-work", "operate-koni"]) {
      assert.equal(
        commands.some((command) => command.name === `skill:${skill}`),
        false,
        `Koni skill ${skill} must be removed without removing the unrelated ambient skill`,
      );
    }
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
  }
}

function providerFreeEnvironment(overrides) {
  const environment = { ...process.env, ...overrides };
  for (const name of Object.keys(environment)) {
    if (environment[name] === undefined) {
      delete environment[name];
      continue;
    }
    if (/(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|SECRET[_-]?KEY)$/iu.test(name))
      delete environment[name];
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
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      return;
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already stopped */
  }
}

async function makeDisposableTreeRemovable(root) {
  await chmod(root, 0o700).catch(() => undefined);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return;
      await makeDisposableTreeRemovable(path.join(root, entry.name));
    }),
  );
}

async function listRelativePaths(root, current = root) {
  if (!existsSync(current)) return [];
  const result = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    result.push(relative);
    if (entry.isDirectory()) result.push(...(await listRelativePaths(root, absolute)));
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

async function snapshotTreeModes(root, current = root) {
  const snapshot = {};
  if (!existsSync(current)) return snapshot;
  snapshot[path.relative(root, current).split(path.sep).join("/") || "."] =
    (await stat(current)).mode & 0o777;
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    snapshot[relative] = (await stat(absolute)).mode & 0o777;
    if (entry.isDirectory()) Object.assign(snapshot, await snapshotTreeModes(root, absolute));
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
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        if (value.type === "response" && value.id === id) {
          clearTimeout(timeout);
          child.stdout.off("data", inspect);
          if (value.success !== true)
            reject(new Error(`Pi RPC rejected ${id}: ${value.error ?? "unknown"}`));
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
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const inspect = (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timeout);
      child.stdout.off("data", inspect);
      try {
        resolve(JSON.parse(stdout.slice(0, newline)));
      } catch (error) {
        reject(
          new Error(`packed authority racer emitted invalid JSON: ${stdout}`, { cause: error }),
        );
      }
    };
    child.stdout.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!stdout.includes("\n")) {
        clearTimeout(timeout);
        reject(
          new Error(`packed authority racer exited ${code}\nstdout=${stdout}\nstderr=${stderr}`),
        );
      }
    });
  });
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`child ${child.pid} did not exit`)),
      timeoutMs,
    );
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

function stripTerminalControls(value) {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001bP[\s\S]*?\u001b\\/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[@-_]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}
