#!/usr/bin/env node

import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const SUPPORTED_PI = /^0\.80\.10$/u;

export async function preparePiRuntime() {
  const piPackageRoot = findPiPackageRoot();
  const manifest = JSON.parse(readFileSync(path.join(piPackageRoot, "package.json"), "utf8"));
  if (manifest.name !== PI_PACKAGE || !SUPPORTED_PI.test(manifest.version ?? "")) {
    throw new Error(
      `the active Pi runtime must be 0.80.10 (found ${manifest.name ?? "unknown"}@${manifest.version ?? "unknown"})`,
    );
  }

  process.env.KONI_PI_PACKAGE_ROOT = piPackageRoot;
  const registerURL = new URL("./pi-peer-register.js", import.meta.url).href;
  const importOption = `--import=${registerURL}`;
  const nodeOptions = process.env.NODE_OPTIONS?.trim() ?? "";
  if (!nodeOptions.split(/\s+/u).includes(importOption)) {
    process.env.NODE_OPTIONS = nodeOptions ? `${nodeOptions} ${importOption}` : importOption;
  }
  await import("./pi-peer-register.js");
  return piPackageRoot;
}

export async function main() {
  await preparePiRuntime();
  const cli = await import("../dist/cli.js");
  return cli.runKoniCli(process.argv.slice(2));
}

export function findPiPackageRoot() {
  if (process.env.KONI_PI_PACKAGE_ROOT) {
    const explicit = firstValidPiRoot([process.env.KONI_PI_PACKAGE_ROOT]);
    if (explicit !== undefined) return explicit;
    throw new Error("KONI_PI_PACKAGE_ROOT does not identify @earendil-works/pi-coding-agent");
  }

  const executableNames =
    process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi", "pi.cmd"];
  let activeExecutable;
  search: for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const executableName of executableNames) {
      const executable = path.join(directory, executableName);
      if (!isRunnableExecutable(executable)) continue;
      activeExecutable = executable;
      break search;
    }
  }
  if (activeExecutable !== undefined) {
    const directShimCandidates = shimCandidates(activeExecutable);
    const root = firstValidPiRoot([
      activeExecutable,
      realpathOrSelf(activeExecutable),
      ...directShimCandidates,
      ...directShimCandidates.flatMap((candidate) => shimCandidates(candidate)),
    ]);
    if (root !== undefined) return root;
    throw new Error(
      `the active Pi wrapper at ${activeExecutable} is opaque; set KONI_PI_PACKAGE_ROOT to its verified package directory`,
    );
  }
  throw new Error(
    "could not locate the user's Pi 0.80.10 runtime; install Pi normally and ensure `pi` is on PATH",
  );
}

function isRunnableExecutable(candidate) {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function firstValidPiRoot(candidates) {
  for (const candidate of candidates) {
    const root = ascendToPiPackage(candidate);
    if (root !== undefined && !isNestedKoniPeer(root)) return root;
  }
  return undefined;
}

if (isDirectInvocation()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`koni: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

function isDirectInvocation() {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

export function ascendToPiPackage(candidate) {
  let current = candidate;
  try {
    if (statSync(current).isDirectory()) {
      current = path.resolve(current);
    } else {
      current = path.dirname(realpathOrSelf(current));
    }
  } catch {
    return undefined;
  }
  while (true) {
    const manifestPath = path.join(current, "package.json");
    if (existsSync(manifestPath)) {
      try {
        if (JSON.parse(readFileSync(manifestPath, "utf8")).name === PI_PACKAGE) return current;
      } catch {
        // Keep walking; executable shims may live beneath unrelated package roots.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function shimCandidates(executable) {
  let content;
  try {
    const metadata = statSync(executable);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) return [];
    content = readFileSync(executable, "utf8");
  } catch {
    return [];
  }
  const directory = path.dirname(path.resolve(executable));
  const values = [];
  const tokens =
    content.match(
      /(?:[A-Za-z]:[\\/]|\/|\$basedir[\\/]|\$\{basedir\}[\\/]|%~?dp0%?[\\/]?)[^\s"'`]+/gu,
    ) ?? [];
  for (let token of tokens) {
    token = token
      .replace(/^\$\{?basedir\}?(?:[\\/])?/u, `${directory}${path.sep}`)
      .replace(/^%~?dp0%?(?:[\\/])?/iu, `${directory}${path.sep}`)
      .replaceAll("\\", path.sep)
      .replace(/[),;]+$/u, "");
    if (/^file:\/\//iu.test(token)) {
      try {
        token = fileURLToPath(token);
      } catch {
        continue;
      }
    }
    values.push(path.resolve(token));
  }
  return values;
}

function isNestedKoniPeer(piRoot) {
  const normalized = realpathOrSelf(piRoot).split(path.sep).join("/");
  return normalized.includes("/node_modules/@koni/core/node_modules/");
}

function realpathOrSelf(value) {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}
