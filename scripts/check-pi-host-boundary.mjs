#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const EXACT_PI_VERSION = "0.80.10";
export const EXACT_TYPEBOX_VERSION = "1.1.38";

const CODING_AGENT = "@earendil-works/pi-coding-agent";
const PI_PACKAGES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  CODING_AGENT,
  "@earendil-works/pi-tui",
];
const CODING_AGENT_LOCK_PATH = `node_modules/${CODING_AGENT}`;

function resolveFromCodingAgent(lock, name) {
  const paths =
    name === CODING_AGENT
      ? [CODING_AGENT_LOCK_PATH]
      : [`${CODING_AGENT_LOCK_PATH}/node_modules/${name}`, `node_modules/${name}`];
  for (const lockPath of paths) {
    const entry = lock.packages?.[lockPath];
    if (entry) return { entry, lockPath };
  }
  throw new Error(`${name} is missing from the installed ${CODING_AGENT} lock closure`);
}

export function verifyPiHostBoundary({ lock, manifests }) {
  if (lock.lockfileVersion !== 3 || !lock.packages) {
    throw new Error("the tested Pi host boundary requires an npm lockfileVersion 3 package tree");
  }
  const host = lock.packages[CODING_AGENT_LOCK_PATH];
  if (!host) throw new Error(`${CODING_AGENT} is missing from the root development lock`);

  const resolved = {};
  for (const name of PI_PACKAGES) {
    if (name !== CODING_AGENT && !Object.hasOwn(host.dependencies ?? {}, name)) {
      throw new Error(`${CODING_AGENT} no longer declares ${name} in its tested host closure`);
    }
    const found = resolveFromCodingAgent(lock, name);
    if (found.entry.version !== EXACT_PI_VERSION) {
      throw new Error(
        `${name} lock is ${found.entry.version ?? "missing"}, expected ${EXACT_PI_VERSION}`,
      );
    }
    resolved[name] = { version: found.entry.version, lock_path: found.lockPath };
  }

  if (!Object.hasOwn(host.dependencies ?? {}, "typebox")) {
    throw new Error(`${CODING_AGENT} no longer declares typebox in its tested host closure`);
  }
  const typebox = resolveFromCodingAgent(lock, "typebox");
  if (typebox.entry.version !== EXACT_TYPEBOX_VERSION) {
    throw new Error(
      `typebox lock is ${typebox.entry.version ?? "missing"}, expected ${EXACT_TYPEBOX_VERSION}`,
    );
  }
  resolved.typebox = { version: typebox.entry.version, lock_path: typebox.lockPath };

  for (const manifest of manifests) {
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (
        (PI_PACKAGES.includes(name) || name === "typebox") &&
        (range !== "*" || manifest.peerDependenciesMeta?.[name]?.optional !== true)
      ) {
        throw new Error(`${manifest.name}: ${name} must be an optional native '*' host peer`);
      }
    }
  }
  const root = manifests[0];
  const core = manifests.find((manifest) => manifest.name === "@koni/core");
  if (!core) throw new Error("@koni/core manifest is missing from the release boundary");
  if (root.devDependencies?.[CODING_AGENT] !== EXACT_PI_VERSION) {
    throw new Error(`the tested Pi SDK must remain locked to ${EXACT_PI_VERSION}`);
  }
  if (
    root.devDependencies?.typebox !== EXACT_TYPEBOX_VERSION ||
    core.peerDependencies?.typebox !== "*" ||
    core.peerDependenciesMeta?.typebox?.optional !== true
  ) {
    throw new Error(
      `Core must consume Pi's bundled typebox peer and test against typebox@${EXACT_TYPEBOX_VERSION}`,
    );
  }

  return {
    protocol: "koni.pi-host-compatibility.v1",
    pi: EXACT_PI_VERSION,
    typebox: EXACT_TYPEBOX_VERSION,
    core_api: core.version,
    tested_lock_closure: resolved,
  };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function verifyRepositoryPiHostBoundary(root = process.cwd()) {
  const manifests = await Promise.all(
    [
      "package.json",
      "packages/core/package.json",
      "packages/coding-profile/package.json",
      "packages/research-profile/package.json",
    ].map((file) => readJson(path.join(root, file))),
  );
  return verifyPiHostBoundary({
    lock: await readJson(path.join(root, "package-lock.json")),
    manifests,
  });
}

async function main() {
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex !== -1 && !process.argv[outputIndex + 1]) {
    throw new Error("--output requires a path");
  }
  const attestation = await verifyRepositoryPiHostBoundary();
  if (outputIndex !== -1) {
    await writeFile(process.argv[outputIndex + 1], `${JSON.stringify(attestation, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(attestation, null, 2)}\n`);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
