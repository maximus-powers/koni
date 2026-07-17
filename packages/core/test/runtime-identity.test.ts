import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRuntimeClosureCurrent,
  assertRuntimeClosureFromEnvironment,
  captureCoreRuntimeIdentity,
  captureRuntimeClosure,
  KONI_RUNTIME_CLOSURE_ENV,
  KONI_RUNTIME_PIN_PATH_ENV,
  KONI_RUNTIME_PIN_SHA256_ENV,
  persistRuntimeClosurePin,
  latchCoreRuntimeIdentity,
} from "../src/runtime/identity.js";
import {
  assertRuntimeExecutableCurrent,
  captureRuntimeExecutable,
} from "../src/runtime/executable.js";
import {
  KONI_PI_PACKAGE_ROOT_ENV,
  resolvePiPeerRuntime,
} from "../src/runtime/pi-peer-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env[KONI_RUNTIME_CLOSURE_ENV];
  delete process.env[KONI_RUNTIME_PIN_PATH_ENV];
  delete process.env[KONI_RUNTIME_PIN_SHA256_ENV];
  delete process.env[KONI_PI_PACKAGE_ROOT_ENV];
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime executable identity", () => {
  it("latches the executing build instead of adopting files replaced beneath a live session", async () => {
    const fixture = await runtimeFixture();
    const beforeLoad = await captureCoreRuntimeIdentity(fixture.anchorUrl);
    const latched = latchCoreRuntimeIdentity(fixture.anchorUrl, beforeLoad.buildSha256);
    const replacement = writeFile(fixture.anchorPath, "export const marker = 9;\n", "utf8");
    const executing = await latched.identity();
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

  it("gives a contained child a content-authenticated closure pin", async () => {
    const fixture = await runtimeFixture();
    const closure = await captureRuntimeClosure(fixture.anchorUrl);
    const pin = await persistRuntimeClosurePin(path.join(fixture.root, "state"), closure);
    process.env[KONI_RUNTIME_CLOSURE_ENV] = pin.closureSha256;
    process.env[KONI_RUNTIME_PIN_PATH_ENV] = pin.path;
    process.env[KONI_RUNTIME_PIN_SHA256_ENV] = pin.pinSha256;
    await expect(assertRuntimeClosureFromEnvironment()).resolves.toBeUndefined();

    await writeFile(fixture.anchorPath, "export const marker = 3;\n", "utf8");
    await expect(assertRuntimeClosureFromEnvironment()).rejects.toMatchObject({
      code: "runtime_closure_changed",
    });
  });

  it("binds child preloads to Pi 0.80.10 and its exact TypeBox", async () => {
    const fixture = await runtimeFixture();
    const piRoot = path.join(fixture.root, "pi");
    const typeboxRoot = path.join(piRoot, "node_modules", "typebox");
    await mkdir(typeboxRoot, { recursive: true });
    await writeFile(path.join(piRoot, "package.json"), `${JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.80.10",
    })}\n`);
    await writeFile(path.join(typeboxRoot, "package.json"), `${JSON.stringify({
      name: "typebox",
      version: "1.1.38",
    })}\n`);
    process.env[KONI_PI_PACKAGE_ROOT_ENV] = piRoot;
    const canonicalPiRoot = await realpath(piRoot);
    await expect(resolvePiPeerRuntime(fixture.anchorUrl)).resolves.toMatchObject({
      packageRoot: canonicalPiRoot,
      environment: { [KONI_PI_PACKAGE_ROOT_ENV]: canonicalPiRoot },
    });

    await writeFile(path.join(typeboxRoot, "package.json"), `${JSON.stringify({
      name: "typebox",
      version: "1.3.6",
    })}\n`);
    await expect(resolvePiPeerRuntime(fixture.anchorUrl)).rejects.toMatchObject({
      code: "pi_typebox_version",
    });
  });
});

async function runtimeFixture(): Promise<{
  root: string;
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
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({
    name: "@koni/core",
    version: "1.0.0",
    type: "module",
  })}\n`, "utf8");
  const anchorPath = path.join(sourceRoot, "anchor.js");
  await writeFile(anchorPath, "export const marker = 1;\n", "utf8");
  await writeFile(path.join(binRoot, "pi-peer-register.js"), "export {};\n", "utf8");
  return { root, anchorPath, anchorUrl: pathToFileURL(anchorPath) };
}
