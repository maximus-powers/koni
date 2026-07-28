import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRuntimeClosureCurrent,
  assertRuntimeStageCurrent,
  captureCoreRuntimeIdentity,
  captureRuntimeClosure,
  KONI_RUNTIME_CLOSURE_ENV,
  KONI_RUNTIME_PIN_PATH_ENV,
  KONI_RUNTIME_PIN_SHA256_ENV,
  persistRuntimeClosurePin,
  runtimeStageRoot,
  stagedRuntimePath,
  latchCoreRuntimeIdentity,
} from "../src/runtime/identity.js";
import {
  assertRuntimeExecutableCurrent,
  captureRuntimeExecutable,
} from "../src/runtime/executable.js";
import { KONI_PI_PACKAGE_ROOT_ENV, resolvePiPeerRuntime } from "../src/runtime/pi-peer-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env[KONI_RUNTIME_CLOSURE_ENV];
  delete process.env[KONI_RUNTIME_PIN_PATH_ENV];
  delete process.env[KONI_RUNTIME_PIN_SHA256_ENV];
  delete process.env[KONI_PI_PACKAGE_ROOT_ENV];
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await makeDirectoriesWritable(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("runtime executable identity", () => {
  it("latches the executing build instead of adopting files replaced beneath a live session", async () => {
    const fixture = await runtimeFixture();
    const beforeLoad = await captureCoreRuntimeIdentity(fixture.anchorUrl);
    const latched = latchCoreRuntimeIdentity(fixture.anchorUrl, beforeLoad.buildSha256);
    const executing = await latched.identity();
    const replacement = writeFile(fixture.anchorPath, "export const marker = 9;\n", "utf8");
    await replacement;
    const installed = await captureCoreRuntimeIdentity(fixture.anchorUrl);
    expect(installed.buildSha256).not.toBe(executing.buildSha256);
    expect(executing.buildSha256).toBe(beforeLoad.buildSha256);
    await expect(latched.identity()).resolves.toEqual(executing);
    await expect(latched.assertCurrent()).rejects.toMatchObject({
      code: "core_runtime_changed",
    });
  });

  it("rejects an executable whose bytes changed after authority startup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "koni-runtime-executable-"));
    roots.push(root);
    const executable = path.join(root, "tool");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o700);
    const identity = await captureRuntimeExecutable("git", executable);
    await expect(assertRuntimeExecutableCurrent(identity)).resolves.toBeUndefined();

    await writeFile(executable, "#!/bin/sh\nexit 7\n", "utf8");
    await expect(assertRuntimeExecutableCurrent(identity)).rejects.toMatchObject({
      code: "executable_changed",
    });
  });

  it("detects a same-version Core byte refresh and refuses it before child admission", async () => {
    const fixture = await runtimeFixture();
    const firstBuild = await captureCoreRuntimeIdentity(fixture.anchorUrl);
    const closure = await captureRuntimeClosure(fixture.anchorUrl);
    await expect(assertRuntimeClosureCurrent(closure)).resolves.toBeUndefined();

    await writeFile(fixture.anchorPath, "export const marker = 2;\n", "utf8");
    const secondBuild = await captureCoreRuntimeIdentity(fixture.anchorUrl);
    expect(secondBuild.packageVersion).toBe(firstBuild.packageVersion);
    expect(secondBuild.buildSha256).not.toBe(firstBuild.buildSha256);
    await expect(assertRuntimeClosureCurrent(closure)).rejects.toMatchObject({
      code: "runtime_closure_changed",
    });
  });

  it("binds path-independent duplicate-package resolution topology into the closure digest", async () => {
    const fixture = await runtimeFixture();
    const topology = await installDuplicateTopologyFixture(fixture);
    const first = await captureRuntimeClosure(fixture.anchorUrl);

    await Promise.all([unlink(topology.aBridge), unlink(topology.bBridge)]);
    await Promise.all([
      symlink(topology.bridgeTwo, topology.aBridge),
      symlink(topology.bridgeOne, topology.bBridge),
    ]);
    const second = await captureRuntimeClosure(fixture.anchorUrl);

    expect(second.packages).toEqual(first.packages);
    expect(second.closureSha256).not.toBe(first.closureSha256);
  });

  it("gives a contained child an immutable content-addressed runtime stage", async () => {
    const fixture = await runtimeFixture();
    const piRoot = await installFakePi(fixture);
    const closure = await captureRuntimeClosure(fixture.anchorUrl);
    const pin = await persistRuntimeClosurePin(path.join(fixture.root, "state"), closure);
    const peer = await resolvePiPeerRuntime(fixture.anchorUrl);
    const output = path.join(fixture.root, "child-output.txt");
    const piOutput = path.join(fixture.root, "child-pi-root.txt");
    const entryUrlOutput = path.join(fixture.root, "child-entry-url.txt");
    const staged = await runStagedChild(peer.nodeArguments, fixture.anchorPath, {
      ...peer.environment,
      [KONI_RUNTIME_CLOSURE_ENV]: pin.closureSha256,
      [KONI_RUNTIME_PIN_PATH_ENV]: pin.path,
      [KONI_RUNTIME_PIN_SHA256_ENV]: pin.pinSha256,
      KONI_TEST_OUTPUT: output,
      KONI_TEST_PI_OUTPUT: piOutput,
      KONI_TEST_ENTRY_URL_OUTPUT: entryUrlOutput,
    });
    expect(staged, staged.stderr).toMatchObject({ code: 0 });
    await expect(readFile(output, "utf8")).resolves.toBe("old");

    const stage = runtimeStageRoot(pin.path, pin.pinSha256);
    const stagedAnchor = stagedRuntimePath(stage, await realpath(fixture.anchorPath));
    await expect(readFile(piOutput, "utf8")).resolves.toBe(stagedRuntimePath(stage, piRoot));
    await expect(readFile(entryUrlOutput, "utf8")).resolves.toBe(pathToFileURL(stagedAnchor).href);
    expect((await stageDirectoryModes(stage)).filter((entry) => entry.mode !== 0o500)).toEqual([]);
    expect((await lstat(stagedAnchor)).mode & 0o777).toBe(0o400);
    await expect(
      assertRuntimeStageCurrent(pin.path, pin.pinSha256, closure, pathToFileURL(stagedAnchor)),
    ).resolves.toBeUndefined();

    await writeFile(fixture.anchorPath, "export const marker = 3;\n", "utf8");
    await expect(assertRuntimeClosureCurrent(closure)).rejects.toMatchObject({
      code: "runtime_closure_changed",
    });
    await expect(
      assertRuntimeStageCurrent(pin.path, pin.pinSha256, closure, pathToFileURL(stagedAnchor)),
    ).resolves.toBeUndefined();
    expect(piRoot).toBe(peer.packageRoot);
  });

  it("converges concurrent children on one sealed runtime stage", async () => {
    const fixture = await runtimeFixture();
    await installFakePi(fixture);
    const closure = await captureRuntimeClosure(fixture.anchorUrl);
    const pin = await persistRuntimeClosurePin(path.join(fixture.root, "state"), closure);
    const peer = await resolvePiPeerRuntime(fixture.anchorUrl);
    const environment = {
      ...peer.environment,
      [KONI_RUNTIME_CLOSURE_ENV]: pin.closureSha256,
      [KONI_RUNTIME_PIN_PATH_ENV]: pin.path,
      [KONI_RUNTIME_PIN_SHA256_ENV]: pin.pinSha256,
    };
    const outputs = Array.from({ length: 8 }, (_, index) =>
      path.join(fixture.root, `concurrent-${index}.txt`),
    );
    const results = await Promise.all(
      outputs.map((output) =>
        runStagedChild(peer.nodeArguments, fixture.anchorPath, {
          ...environment,
          KONI_TEST_OUTPUT: output,
        }),
      ),
    );

    for (const result of results) expect(result, result.stderr).toMatchObject({ code: 0 });
    for (const output of outputs) await expect(readFile(output, "utf8")).resolves.toBe("old");
    const stage = runtimeStageRoot(pin.path, pin.pinSha256);
    await expect(
      assertRuntimeStageCurrent(
        pin.path,
        pin.pinSha256,
        closure,
        pathToFileURL(stagedRuntimePath(stage, await realpath(fixture.anchorPath))),
      ),
    ).resolves.toBeUndefined();
  });

  it("captures Pi when Core is installed outside Pi's node_modules tree", async () => {
    const fixture = await runtimeFixture();
    const piRoot = await installExternalFakePi(fixture);
    delete process.env[KONI_PI_PACKAGE_ROOT_ENV];

    const closure = await captureRuntimeClosure(fixture.anchorUrl, piRoot);

    expect(
      closure.files.some((entry) => entry.path === path.join(piRoot, "dist", "index.js")),
    ).toBe(true);
    expect(closure.resolutions).toContainEqual({
      parentPackageRoot: await realpath(fixture.packageRoot),
      dependency: "@earendil-works/pi-coding-agent",
      packageRoot: piRoot,
    });
  });

  it("binds child preloads to Pi 0.80.10 and its exact TypeBox", async () => {
    const fixture = await runtimeFixture();
    const canonicalPiRoot = await installFakePi(fixture);
    const typeboxRoot = path.join(fixture.root, "node_modules", "typebox");
    await expect(resolvePiPeerRuntime(fixture.anchorUrl)).resolves.toMatchObject({
      packageRoot: canonicalPiRoot,
      preloadUrl: expect.stringMatching(/^data:text\/javascript;base64,/u),
      nodeArguments: [expect.stringMatching(/^--import=data:text\/javascript;base64,/u)],
      environment: { [KONI_PI_PACKAGE_ROOT_ENV]: canonicalPiRoot },
    });
    const directRegister = await runNodeProcess(
      [
        `--import=${pathToFileURL(path.join(fixture.packageRoot, "bin", "pi-peer-register.js")).href}`,
        "--input-type=module",
        "--eval",
        'await import("@earendil-works/pi-coding-agent");',
      ],
      { [KONI_PI_PACKAGE_ROOT_ENV]: canonicalPiRoot },
    );
    expect(directRegister, directRegister.stderr).toMatchObject({ code: 0 });

    await writeFile(
      path.join(typeboxRoot, "package.json"),
      `${JSON.stringify({
        name: "typebox",
        version: "1.3.6",
      })}\n`,
    );
    await expect(resolvePiPeerRuntime(fixture.anchorUrl)).rejects.toMatchObject({
      code: "pi_typebox_version",
    });
  });

  it("rejects an invalid pin before a replaced preload or child entry can execute", async () => {
    const fixture = await runtimeFixture();
    await installFakePi(fixture);
    const closure = await captureRuntimeClosure(fixture.anchorUrl);
    const pin = await persistRuntimeClosurePin(path.join(fixture.root, "state"), closure);
    const peer = await resolvePiPeerRuntime(fixture.anchorUrl);
    const preloadSentinel = path.join(fixture.root, "mutable-preload-ran");
    const entrySentinel = path.join(fixture.root, "entry-ran");
    await writeFile(
      path.join(fixture.packageRoot, "bin", "pi-peer-register.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(preloadSentinel)}, "bad");\n`,
      "utf8",
    );

    const result = await runStagedChild(peer.nodeArguments, fixture.anchorPath, {
      ...peer.environment,
      [KONI_RUNTIME_CLOSURE_ENV]: pin.closureSha256,
      [KONI_RUNTIME_PIN_PATH_ENV]: pin.path,
      [KONI_RUNTIME_PIN_SHA256_ENV]: `sha256:${"f".repeat(64)}`,
      KONI_TEST_OUTPUT: entrySentinel,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("runtime pin bytes changed before immutable staging");
    await expect(readFile(preloadSentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(entrySentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a changed reused stage before the entry module can execute", async () => {
    const fixture = await runtimeFixture();
    await installFakePi(fixture);
    const closure = await captureRuntimeClosure(fixture.anchorUrl);
    const pin = await persistRuntimeClosurePin(path.join(fixture.root, "state"), closure);
    const peer = await resolvePiPeerRuntime(fixture.anchorUrl);
    const firstOutput = path.join(fixture.root, "first-stage.txt");
    const maliciousOutput = path.join(fixture.root, "malicious-stage.txt");
    const environment = {
      ...peer.environment,
      [KONI_RUNTIME_CLOSURE_ENV]: pin.closureSha256,
      [KONI_RUNTIME_PIN_PATH_ENV]: pin.path,
      [KONI_RUNTIME_PIN_SHA256_ENV]: pin.pinSha256,
    };
    const first = await runStagedChild(peer.nodeArguments, fixture.anchorPath, {
      ...environment,
      KONI_TEST_OUTPUT: firstOutput,
    });
    expect(first, first.stderr).toMatchObject({ code: 0 });

    const stagedAnchor = stagedRuntimePath(
      runtimeStageRoot(pin.path, pin.pinSha256),
      await realpath(fixture.anchorPath),
    );
    await chmod(stagedAnchor, 0o600);
    await writeFile(
      stagedAnchor,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(maliciousOutput)}, "ran");\n`,
      "utf8",
    );
    await chmod(stagedAnchor, 0o400);

    const second = await runStagedChild(peer.nodeArguments, fixture.anchorPath, environment);
    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain("authenticated runtime stage bytes changed");
    await expect(readFile(maliciousOutput, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a dependency-edge swap in a reused stage before entry execution", async () => {
    const fixture = await runtimeFixture();
    const piRoot = await installFakePi(fixture);
    const closure = await captureRuntimeClosure(fixture.anchorUrl);
    const typeboxResolution = closure.resolutions.find(
      (entry) => entry.parentPackageRoot === piRoot && entry.dependency === "typebox",
    );
    expect(typeboxResolution).toBeDefined();
    const pin = await persistRuntimeClosurePin(path.join(fixture.root, "state"), closure);
    const peer = await resolvePiPeerRuntime(fixture.anchorUrl);
    const firstOutput = path.join(fixture.root, "edge-first.txt");
    const secondOutput = path.join(fixture.root, "edge-second.txt");
    const environment = {
      ...peer.environment,
      [KONI_RUNTIME_CLOSURE_ENV]: pin.closureSha256,
      [KONI_RUNTIME_PIN_PATH_ENV]: pin.path,
      [KONI_RUNTIME_PIN_SHA256_ENV]: pin.pinSha256,
    };
    const first = await runStagedChild(peer.nodeArguments, fixture.anchorPath, {
      ...environment,
      KONI_TEST_OUTPUT: firstOutput,
    });
    expect(first, first.stderr).toMatchObject({ code: 0 });

    const stage = runtimeStageRoot(pin.path, pin.pinSha256);
    const stagedPiRoot = stagedRuntimePath(stage, piRoot);
    const resolutionLink = path.join(stagedPiRoot, "node_modules", "typebox");
    const resolutionParent = path.dirname(resolutionLink);
    await chmod(resolutionParent, 0o700);
    await unlink(resolutionLink);
    await symlink(path.relative(resolutionParent, stagedPiRoot), resolutionLink);
    await chmod(resolutionParent, 0o500);

    const second = await runStagedChild(peer.nodeArguments, fixture.anchorPath, {
      ...environment,
      KONI_TEST_OUTPUT: secondOutput,
    });
    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain("authenticated runtime dependency resolution changed: typebox");
    await expect(readFile(secondOutput, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("executes the pinned staged generation after deterministic source-tree replacement", async () => {
    const fixture = await runtimeFixture();
    await installFakePi(fixture);
    const closure = await captureRuntimeClosure(fixture.anchorUrl);
    const pin = await persistRuntimeClosurePin(path.join(fixture.root, "state"), closure);
    const peer = await resolvePiPeerRuntime(fixture.anchorUrl);
    const firstOutput = path.join(fixture.root, "first.txt");
    const secondOutput = path.join(fixture.root, "second.txt");
    const environment = {
      ...peer.environment,
      [KONI_RUNTIME_CLOSURE_ENV]: pin.closureSha256,
      [KONI_RUNTIME_PIN_PATH_ENV]: pin.path,
      [KONI_RUNTIME_PIN_SHA256_ENV]: pin.pinSha256,
    };

    const first = await runStagedChild(peer.nodeArguments, fixture.anchorPath, {
      ...environment,
      KONI_TEST_OUTPUT: firstOutput,
    });
    expect(first, first.stderr).toMatchObject({ code: 0 });
    await writeFile(
      fixture.anchorPath,
      [
        'import { writeFileSync } from "node:fs";',
        'import { marker } from "./dependency.js";',
        "writeFileSync(process.env.KONI_TEST_OUTPUT, `new-entry:${marker}`);",
        "export { marker };",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(fixture.packageRoot, "src", "dependency.js"),
      'export const marker = "new";\n',
    );

    const second = await runStagedChild(peer.nodeArguments, fixture.anchorPath, {
      ...environment,
      KONI_TEST_OUTPUT: secondOutput,
    });
    expect(second, second.stderr).toMatchObject({ code: 0 });
    await expect(readFile(firstOutput, "utf8")).resolves.toBe("old");
    await expect(readFile(secondOutput, "utf8")).resolves.toBe("old");
  });
});

async function runtimeFixture(): Promise<{
  root: string;
  packageRoot: string;
  anchorPath: string;
  anchorUrl: URL;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-runtime-identity-"));
  roots.push(root);
  const packageRoot = path.join(root, "core");
  const sourceRoot = path.join(packageRoot, "src");
  const binRoot = path.join(packageRoot, "bin");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(binRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "@koni/core",
      version: "1.0.0",
      type: "module",
    })}\n`,
    "utf8",
  );
  const anchorPath = path.join(sourceRoot, "anchor.js");
  await writeFile(
    anchorPath,
    [
      'import { realpathSync, writeFileSync } from "node:fs";',
      'import { fileURLToPath } from "node:url";',
      'import "@earendil-works/pi-coding-agent";',
      'import { marker } from "./dependency.js";',
      "if (process.env.KONI_TEST_OUTPUT) writeFileSync(process.env.KONI_TEST_OUTPUT, marker);",
      "if (process.env.KONI_TEST_PI_OUTPUT) writeFileSync(process.env.KONI_TEST_PI_OUTPUT, process.env.KONI_PI_PACKAGE_ROOT ?? '');",
      "if (process.env.KONI_TEST_ENTRY_URL_OUTPUT && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) writeFileSync(process.env.KONI_TEST_ENTRY_URL_OUTPUT, import.meta.url);",
      "export { marker };",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(sourceRoot, "dependency.js"), 'export const marker = "old";\n', "utf8");
  const [registerSource, loaderSource] = await Promise.all([
    readFile(new URL("../bin/pi-peer-register.js", import.meta.url)),
    readFile(new URL("../bin/pi-peer-loader.js", import.meta.url)),
  ]);
  await writeFile(path.join(binRoot, "pi-peer-register.js"), registerSource);
  await writeFile(path.join(binRoot, "pi-peer-loader.js"), loaderSource);
  return { root, packageRoot, anchorPath, anchorUrl: pathToFileURL(anchorPath) };
}

async function installFakePi(fixture: Awaited<ReturnType<typeof runtimeFixture>>): Promise<string> {
  const piRoot = path.join(fixture.root, "node_modules", "@earendil-works", "pi-coding-agent");
  const typeboxRoot = path.join(fixture.root, "node_modules", "typebox");
  await Promise.all([mkdir(piRoot, { recursive: true }), mkdir(typeboxRoot, { recursive: true })]);
  await writeFile(
    path.join(fixture.packageRoot, "package.json"),
    `${JSON.stringify({
      name: "@koni/core",
      version: "1.0.0",
      type: "module",
      peerDependencies: {
        "@earendil-works/pi-coding-agent": "0.80.10",
      },
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(piRoot, "package.json"),
    `${JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.80.10",
      type: "module",
      exports: "./dist/index.js",
      dependencies: { typebox: "1.1.38" },
    })}\n`,
    "utf8",
  );
  await mkdir(path.join(piRoot, "dist"), { recursive: true });
  await writeFile(
    path.join(piRoot, "dist", "index.js"),
    'import { TypeBoxFixture } from "typebox"; export const piFixture = TypeBoxFixture;\n',
    "utf8",
  );
  await writeFile(
    path.join(typeboxRoot, "package.json"),
    `${JSON.stringify({
      name: "typebox",
      version: "1.1.38",
      type: "module",
      exports: "./index.js",
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(typeboxRoot, "index.js"),
    "export const TypeBoxFixture = true;\n",
    "utf8",
  );
  process.env[KONI_PI_PACKAGE_ROOT_ENV] = piRoot;
  return realpath(piRoot);
}

async function installExternalFakePi(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
): Promise<string> {
  const externalRoot = path.join(fixture.root, "pi-install");
  const piRoot = path.join(externalRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  const typeboxRoot = path.join(externalRoot, "node_modules", "typebox");
  await Promise.all([
    mkdir(path.join(piRoot, "dist"), { recursive: true }),
    mkdir(typeboxRoot, { recursive: true }),
  ]);
  await writeFile(
    path.join(fixture.packageRoot, "package.json"),
    `${JSON.stringify({
      name: "@koni/core",
      version: "1.0.0",
      type: "module",
      peerDependencies: {
        "@earendil-works/pi-coding-agent": "0.80.10",
      },
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(piRoot, "package.json"),
    `${JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.80.10",
      type: "module",
      exports: "./dist/index.js",
      dependencies: { typebox: "1.1.38" },
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(piRoot, "dist", "index.js"),
    'import { TypeBoxFixture } from "typebox"; export const piFixture = TypeBoxFixture;\n',
    "utf8",
  );
  await writeFile(
    path.join(typeboxRoot, "package.json"),
    `${JSON.stringify({
      name: "typebox",
      version: "1.1.38",
      type: "module",
      exports: "./index.js",
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(typeboxRoot, "index.js"),
    "export const TypeBoxFixture = true;\n",
    "utf8",
  );
  return realpath(piRoot);
}

async function installDuplicateTopologyFixture(
  fixture: Awaited<ReturnType<typeof runtimeFixture>>,
): Promise<{
  aBridge: string;
  bBridge: string;
  bridgeOne: string;
  bridgeTwo: string;
}> {
  await writeFile(
    path.join(fixture.packageRoot, "package.json"),
    `${JSON.stringify({
      name: "@koni/core",
      version: "1.0.0",
      type: "module",
      dependencies: { a: "1.0.0", b: "1.0.0" },
    })}\n`,
    "utf8",
  );
  const packages = path.join(fixture.root, "topology-packages");
  const a = path.join(packages, "a");
  const b = path.join(packages, "b");
  const bridgeOne = path.join(packages, "bridge-one");
  const bridgeTwo = path.join(packages, "bridge-two");
  const leafOne = path.join(packages, "leaf-one");
  const leafTwo = path.join(packages, "leaf-two");
  for (const [root, name, dependencies, marker] of [
    [a, "a", { bridge: "1.0.0" }, "a"],
    [b, "b", { bridge: "1.0.0" }, "b"],
    [bridgeOne, "bridge", { leaf: "1.0.0" }, "same-bridge"],
    [bridgeTwo, "bridge", { leaf: "1.0.0" }, "same-bridge"],
    [leafOne, "leaf", {}, "leaf-one"],
    [leafTwo, "leaf", {}, "leaf-two"],
  ] as const) {
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify({
        name,
        version: "1.0.0",
        type: "module",
        dependencies,
      })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(root, "index.js"),
      `export const marker = ${JSON.stringify(marker)};\n`,
      "utf8",
    );
  }
  await mkdir(path.join(fixture.packageRoot, "node_modules"), { recursive: true });
  await symlink(a, path.join(fixture.packageRoot, "node_modules", "a"));
  await symlink(b, path.join(fixture.packageRoot, "node_modules", "b"));
  const aBridge = path.join(a, "node_modules", "bridge");
  const bBridge = path.join(b, "node_modules", "bridge");
  await symlink(bridgeOne, aBridge);
  await symlink(bridgeTwo, bBridge);
  await symlink(leafOne, path.join(bridgeOne, "node_modules", "leaf"));
  await symlink(leafTwo, path.join(bridgeTwo, "node_modules", "leaf"));
  return { aBridge, bBridge, bridgeOne, bridgeTwo };
}

function runStagedChild(
  nodeArguments: readonly string[],
  entry: string,
  environment: Readonly<Record<string, string>>,
): Promise<{ code: number | null; stderr: string }> {
  return runNodeProcess([...nodeArguments, entry], environment);
}

function runNodeProcess(
  nodeArguments: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArguments, {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code, stderr: Buffer.concat(stderr).toString("utf8") }),
    );
  });
}

async function makeDirectoriesWritable(directory: string): Promise<void> {
  const metadata = await lstat(directory).catch(() => undefined);
  if (metadata === undefined || !metadata.isDirectory() || metadata.isSymbolicLink()) return;
  await chmod(directory, 0o700);
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => makeDirectoriesWritable(path.join(directory, entry.name))),
  );
}

async function stageDirectoryModes(
  directory: string,
): Promise<Array<{ path: string; mode: number }>> {
  const metadata = await lstat(directory);
  const modes = [{ path: directory, mode: metadata.mode & 0o777 }];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      modes.push(...(await stageDirectoryModes(path.join(directory, entry.name))));
    }
  }
  return modes;
}
