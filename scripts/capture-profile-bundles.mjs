#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ORACLE_COMMIT = "fcc425e51114bcedb9aeae44d6e8c8418a525e6b";
export const ORACLE_TAG = "rust-oracle-baseline";
export const PROFILE_PACKAGE_PROTOCOL = "koni.profile-package.v1";

export const PROFILE_DEFINITIONS = Object.freeze([
  Object.freeze({
    captureDirectory: "coding",
    packageDirectory: "coding-profile",
    packageName: "@koni/coding-profile",
    packageVersion: "0.6.0",
    profileId: "software",
    displayName: "Coding",
    profileVersion: "0.6.0",
    lineage: "koni.software",
    expectedFileCount: 45,
  }),
  Object.freeze({
    captureDirectory: "research",
    packageDirectory: "research-profile",
    packageName: "@koni/research-profile",
    packageVersion: "1.0.10",
    profileId: "research",
    displayName: "Research",
    profileVersion: "1.0.10",
    lineage: "koni.research",
    expectedFileCount: 48,
  }),
]);

const GENERATED_ORACLE_FILES = new Set([
  "migration-receipt.json",
  "resource-manifest.json",
]);

const COMPATIBILITY = Object.freeze({
  core_api_range: ">=1.0.0 <2.0.0",
  profile_schema_range: ">=2.0.0 <3.0.0",
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

async function copyTree(sourceRoot, destinationRoot, shouldInclude = () => true) {
  for (const source of await collectRegularFiles(sourceRoot)) {
    const relativePath = portablePath(relative(sourceRoot, source));
    if (!shouldInclude(relativePath)) {
      continue;
    }
    const destination = join(destinationRoot, ...relativePath.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
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

export function digestBaseline(files) {
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
  return `sha256:${hash.digest("hex")}`;
}

function manifestFor(definition, files) {
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
    bundle_sha256: digestBaseline(files),
  };
}

async function validateCapturedProfile(definition, capturedConfigRoot) {
  const profile = await readFile(join(capturedConfigRoot, "profile.yaml"), "utf8");
  if (!/^schema_version: ['"]2\.0['"]/m.test(profile)) {
    throw new Error(`${definition.profileId} oracle capture is not schema 2`);
  }
  if (!profile.includes(`  id: ${definition.profileId}`)) {
    throw new Error(`${definition.profileId} oracle capture has a different profile id`);
  }
  if (!profile.includes(`  version: ${definition.profileVersion}`)) {
    throw new Error(`${definition.profileId} oracle capture has a different profile version`);
  }
}

export async function captureProfileBundle(captureRoot, definition) {
  const capturedProject = join(captureRoot, definition.captureDirectory);
  const capturedConfigRoot = join(capturedProject, ".koni");
  const capturedSkillsRoot = join(capturedProject, ".agents", "skills");
  await validateCapturedProfile(definition, capturedConfigRoot);

  const packageRoot = join(repositoryRoot, "packages", definition.packageDirectory);
  const koniRoot = join(packageRoot, "koni");
  const baselineRoot = join(koniRoot, "baseline");
  await rm(baselineRoot, { recursive: true, force: true });
  await mkdir(baselineRoot, { recursive: true });
  await copyTree(
    capturedConfigRoot,
    baselineRoot,
    (path) => !GENERATED_ORACLE_FILES.has(path),
  );
  await copyTree(capturedSkillsRoot, join(baselineRoot, "resources", "skills"));

  const files = await inspectBaseline(baselineRoot);
  if (files.length !== definition.expectedFileCount) {
    throw new Error(
      `${definition.profileId} baseline contains ${files.length} files; expected ${definition.expectedFileCount}`,
    );
  }
  const manifest = manifestFor(definition, files);
  await writeFile(
    join(koniRoot, "profile-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    join(koniRoot, "oracle-provenance.json"),
    `${JSON.stringify(
      {
        oracle_tag: ORACLE_TAG,
        oracle_commit: ORACLE_COMMIT,
        capture_kind: "fresh-schema2-install",
        captured_profile: {
          id: definition.profileId,
          version: definition.profileVersion,
        },
        excluded_generated_paths: [...GENERATED_ORACLE_FILES].sort(),
      },
      null,
      2,
    )}\n`,
  );
  return manifest;
}

function parseArguments(argv) {
  let captureRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--capture-root") {
      captureRoot = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!captureRoot) {
    throw new Error("usage: npm run profiles:capture -- --capture-root <oracle-install-root>");
  }
  return { captureRoot: resolve(captureRoot) };
}

export async function main(argv = process.argv.slice(2)) {
  const { captureRoot } = parseArguments(argv);
  for (const definition of PROFILE_DEFINITIONS) {
    const manifest = await captureProfileBundle(captureRoot, definition);
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
