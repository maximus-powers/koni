#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PROFILE_PACKAGE_PROTOCOL = "koni.profile-package.v1";

export const PROFILE_DEFINITIONS = Object.freeze([
  Object.freeze({
    packageDirectory: "coding-profile",
    packageName: "@koni/coding-profile",
    packageVersion: "0.8.23",
    profileId: "software",
    displayName: "Coding",
    profileVersion: "0.8.23",
    lineage: "koni.software",
    expectedFileCount: 27,
    migration: Object.freeze({
      id: "retire-inert-semantics-v1",
      kind: "retire_yaml_fields",
      fromProfileRange: ">=0.7.0 <0.8.0",
      fromBundleSha256: Object.freeze([
        "sha256:4e955f7fb5a6bbd58542f395471d2e3f1c87364840abd218f973b8f62a5c0c7e",
      ]),
      path: "migrations/retire-inert-semantics-v1.json",
    }),
  }),
  Object.freeze({
    packageDirectory: "research-profile",
    packageName: "@koni/research-profile",
    packageVersion: "1.1.35",
    profileId: "research",
    displayName: "Research",
    profileVersion: "1.1.35",
    lineage: "koni.research",
    expectedFileCount: 29,
    migration: Object.freeze({
      id: "retire-inert-semantics-v1",
      kind: "retire_yaml_fields",
      fromProfileRange: ">=1.0.11 <1.1.0",
      fromBundleSha256: Object.freeze([
        "sha256:1bc8bdb64934ccd475f50acad5b22a7b1b6f7e168a748ecd91e234be76126c60",
      ]),
      path: "migrations/retire-inert-semantics-v1.json",
    }),
  }),
]);

const COMPATIBILITY = Object.freeze({
  core_api_range: ">=1.0.0 <2.0.0",
  profile_schema_range: ">=3.0.0 <4.0.0",
  pi_range: ">=0.80.10 <0.81.0",
});

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function portablePath(path) {
  return path.split(sep).join("/");
}

function classifyFile(path) {
  if (path.startsWith("agents/")) {
    return "agent";
  }
  if (path.startsWith("resources/skills/")) {
    return "skill";
  }
  if (path.endsWith(".yaml") || path.endsWith(".yml")) {
    return "config";
  }
  return "other";
}

async function collectRegularFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const files = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      throw new Error(`profile bundles may not contain symlinks: ${absolute}`);
    }
    if (metadata.isDirectory()) {
      files.push(...(await collectRegularFiles(root, absolute)));
    } else if (metadata.isFile()) {
      files.push(absolute);
    } else {
      throw new Error(`profile bundles may contain only regular files: ${absolute}`);
    }
  }
  return files;
}

export async function inspectBaseline(baselineRoot) {
  const files = [];
  for (const absolute of await collectRegularFiles(baselineRoot)) {
    const path = portablePath(relative(baselineRoot, absolute));
    const bytes = await readFile(absolute);
    files.push({
      path,
      sha256: sha256(bytes),
      size_bytes: bytes.byteLength,
      kind: classifyFile(path),
    });
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return files;
}

export function digestBaseline(files, migrations = []) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path, "utf8");
    hash.update("\0");
    hash.update(file.sha256, "utf8");
    hash.update("\0");
    hash.update(String(file.size_bytes), "utf8");
    hash.update("\0");
    hash.update(file.kind, "utf8");
    hash.update("\0");
  }
  if (migrations.length > 0) {
    hash.update("koni.profile-migrations.v1\0", "utf8");
    const records = migrations.map((migration) => canonicalJson(migration)).sort(compareUtf8);
    for (const record of records) hash.update(`${record}\0`, "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

function manifestFor(definition, files, migrations = []) {
  return {
    protocol: PROFILE_PACKAGE_PROTOCOL,
    package: {
      name: definition.packageName,
      version: definition.packageVersion,
    },
    profile: {
      id: definition.profileId,
      display_name: definition.displayName,
      version: definition.profileVersion,
      lineage: definition.lineage,
    },
    compatibility: { ...COMPATIBILITY },
    baseline: {
      root: "./baseline",
      files,
    },
    ...(migrations.length === 0 ? {} : { migrations }),
    bundle_sha256: digestBaseline(files, migrations),
  };
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object")
    throw new Error("profile migration descriptor is not canonical JSON data");
  const keys = Object.keys(value).sort(compareUtf8);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function releaseMigrations(packageRoot, definition) {
  const migration = definition.migration;
  if (migration === undefined) return [];
  const resource = await readFile(join(packageRoot, "koni", migration.path));
  return [
    {
      id: migration.id,
      kind: migration.kind,
      from_profile_range: migration.fromProfileRange,
      from_bundle_sha256: [...migration.fromBundleSha256].sort(compareUtf8),
      path: migration.path,
      sha256: sha256(resource),
    },
  ];
}

async function validateBaselineProfile(definition, configRoot) {
  const profile = await readFile(join(configRoot, "profile.yaml"), "utf8");
  if (!/^schema_version: ['"]3\.0['"]/m.test(profile)) {
    throw new Error(`${definition.profileId} baseline is not schema 3`);
  }
  if (!profile.includes(`  id: ${definition.profileId}`)) {
    throw new Error(`${definition.profileId} baseline has a different profile id`);
  }
  if (!profile.includes(`  version: ${definition.profileVersion}`)) {
    throw new Error(`${definition.profileId} baseline has a different profile version`);
  }
}

/** Publish a reviewed in-tree profile without copying or replacing any baseline byte. */
export async function publishCurrentProfileBundle(definition) {
  const packageRoot = join(repositoryRoot, "packages", definition.packageDirectory);
  const koniRoot = join(packageRoot, "koni");
  const baselineRoot = join(koniRoot, "baseline");
  await validateBaselineProfile(definition, baselineRoot);
  const files = await inspectBaseline(baselineRoot);
  if (files.length !== definition.expectedFileCount) {
    throw new Error(
      `${definition.profileId} baseline contains ${files.length} files; expected ${definition.expectedFileCount}`,
    );
  }
  const migrations = await releaseMigrations(packageRoot, definition);
  const manifest = manifestFor(definition, files, migrations);
  await writeFile(
    join(koniRoot, "profile-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

function parseArguments(argv) {
  if (argv.length !== 1 || argv[0] !== "--publish-current") {
    throw new Error("usage: capture-profile-bundles.mjs --publish-current");
  }
}

export async function main(argv = process.argv.slice(2)) {
  parseArguments(argv);
  for (const definition of PROFILE_DEFINITIONS) {
    const manifest = await publishCurrentProfileBundle(definition);
    process.stdout.write(
      `${manifest.package.name} ${manifest.profile.version}: ${manifest.baseline.files.length} files, ${manifest.bundle_sha256}\n`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
