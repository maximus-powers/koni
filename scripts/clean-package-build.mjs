#!/usr/bin/env node

import { lstat, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";

const requestedRoot = process.argv[2];
if (process.argv.length !== 3 || requestedRoot === undefined) {
  throw new Error("usage: clean-package-build.mjs PACKAGE_ROOT");
}

const packageRoot = await realpath(path.resolve(process.cwd(), requestedRoot));
const manifestPath = path.join(packageRoot, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (
  typeof manifest.name !== "string" ||
  !Array.isArray(manifest.files) ||
  !manifest.files.includes("dist")
) {
  throw new Error("refusing to clean a package that does not declare dist as a published path");
}

const outputPath = path.join(packageRoot, "dist");
const relativeOutput = path.relative(packageRoot, outputPath);
if (relativeOutput !== "dist") {
  throw new Error("refusing to clean an output path outside the package root");
}

const metadata = await lstat(outputPath).catch((error) => {
  if (error?.code === "ENOENT") return undefined;
  throw error;
});
if (metadata?.isSymbolicLink()) {
  throw new Error("refusing to clean a symbolic-link build output");
}
await rm(outputPath, { recursive: true, force: true });
