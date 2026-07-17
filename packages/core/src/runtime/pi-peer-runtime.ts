import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const KONI_PI_PACKAGE_ROOT_ENV = "KONI_PI_PACKAGE_ROOT" as const;
export const SUPPORTED_PI_RUNTIME_VERSION = "0.80.10" as const;
export const SUPPORTED_TYPEBOX_VERSION = "1.1.38" as const;

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

export interface PiPeerRuntime {
  packageRoot: string;
  preloadPath: string;
  preloadUrl: string;
  nodeArguments: readonly string[];
  environment: Readonly<Record<string, string>>;
}

export class PiPeerRuntimeError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "PiPeerRuntimeError";
    this.code = code;
  }
}

/** Locate and authenticate the same Pi runtime that loaded Koni's extension/launcher. */
export async function resolvePiPeerRuntime(
  anchorUrl: string | URL = import.meta.url,
): Promise<PiPeerRuntime> {
  const candidates = [
    process.env[KONI_PI_PACKAGE_ROOT_ENV],
    process.argv[1],
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  let packageRoot: string | undefined;
  for (const candidate of candidates) {
    packageRoot = await ascendToPackage(candidate, PI_PACKAGE_NAME);
    if (packageRoot !== undefined) break;
  }
  if (packageRoot === undefined) {
    throw new PiPeerRuntimeError(
      "pi_runtime_missing",
      "cannot locate the active Pi package root; launch Koni through the installed Pi package or its `koni` command",
    );
  }
  const manifest = await packageIdentity(packageRoot);
  if (manifest.name !== PI_PACKAGE_NAME || manifest.version !== SUPPORTED_PI_RUNTIME_VERSION) {
    throw new PiPeerRuntimeError(
      "pi_runtime_version",
      `Koni requires Pi ${SUPPORTED_PI_RUNTIME_VERSION}; active runtime is ${manifest.name}@${manifest.version}`,
    );
  }
  const typeboxRoot = await resolveNodePackageRoot(packageRoot, "typebox");
  if (typeboxRoot === undefined) {
    throw new PiPeerRuntimeError("pi_typebox_missing", "the active Pi runtime cannot resolve typebox");
  }
  const typebox = await packageIdentity(typeboxRoot);
  if (typebox.name !== "typebox" || typebox.version !== SUPPORTED_TYPEBOX_VERSION) {
    throw new PiPeerRuntimeError(
      "pi_typebox_version",
      `Koni requires Pi's typebox ${SUPPORTED_TYPEBOX_VERSION}; active runtime has ${typebox.version}`,
    );
  }

  const anchor = await realpath(fileURLToPath(anchorUrl));
  const coreRoot = await ascendToPackage(anchor, "@koni/core");
  if (coreRoot === undefined) {
    throw new PiPeerRuntimeError("core_runtime_missing", "cannot locate the active @koni/core package root");
  }
  const preloadPath = path.join(coreRoot, "bin", "pi-peer-register.js");
  const preload = await lstat(preloadPath).catch(() => undefined);
  if (preload === undefined || !preload.isFile() || preload.isSymbolicLink()) {
    throw new PiPeerRuntimeError(
      "pi_peer_preload_missing",
      "@koni/core is missing its authenticated Pi peer preload",
    );
  }
  const preloadUrl = pathToFileURL(preloadPath).href;
  return {
    packageRoot,
    preloadPath,
    preloadUrl,
    nodeArguments: [`--import=${preloadUrl}`],
    environment: { [KONI_PI_PACKAGE_ROOT_ENV]: packageRoot },
  };
}

async function ascendToPackage(candidate: string, expectedName: string): Promise<string | undefined> {
  let current: string;
  try {
    const canonical = await realpath(candidate);
    const metadata = await lstat(canonical);
    current = metadata.isDirectory() ? canonical : path.dirname(canonical);
  } catch {
    return undefined;
  }
  for (;;) {
    try {
      const identity = await packageIdentity(current);
      if (identity.name === expectedName) return current;
    } catch {
      // Executable shims and parent directories are not package roots.
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function resolveNodePackageRoot(
  parentPackageRoot: string,
  dependency: string,
): Promise<string | undefined> {
  const segments = dependency.startsWith("@") ? dependency.split("/") : [dependency];
  let current = parentPackageRoot;
  for (;;) {
    const candidate = path.join(current, "node_modules", ...segments);
    try {
      const canonical = await realpath(candidate);
      const identity = await packageIdentity(canonical);
      if (identity.name !== dependency) {
        throw new PiPeerRuntimeError(
          "pi_peer_identity",
          `${dependency} resolved to ${identity.name}`,
        );
      }
      return canonical;
    } catch (error) {
      if (error instanceof PiPeerRuntimeError) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function packageIdentity(packageRoot: string): Promise<{ name: string; version: string }> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  } catch {
    throw new PiPeerRuntimeError("pi_package_manifest", `cannot read package manifest at ${packageRoot}`);
  }
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.version !== "string") {
    throw new PiPeerRuntimeError("pi_package_manifest", `invalid package manifest at ${packageRoot}`);
  }
  return { name: value.name, version: value.version };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
