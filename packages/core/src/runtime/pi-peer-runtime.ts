import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const KONI_PI_PACKAGE_ROOT_ENV = "KONI_PI_PACKAGE_ROOT" as const;
export const SUPPORTED_PI_RUNTIME_VERSION = "0.80.10" as const;
export const SUPPORTED_TYPEBOX_VERSION = "1.1.38" as const;

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const MAX_BOOTSTRAP_SOURCE_BYTES = 1024 * 1024;
const LOADER_URL_MARKER = "__KONI_PI_PEER_LOADER_URL__";
const BOOTSTRAP_BINDING_MARKER = "__KONI_PI_PEER_BOOTSTRAP_BINDING__";

interface PiPeerBootstrapBinding {
  registerPath: string;
  registerSha256: string;
  loaderPath: string;
  loaderSha256: string;
}

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
  const candidates = [process.env[KONI_PI_PACKAGE_ROOT_ENV], process.argv[1]].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
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
    throw new PiPeerRuntimeError(
      "pi_typebox_missing",
      "the active Pi runtime cannot resolve typebox",
    );
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
    throw new PiPeerRuntimeError(
      "core_runtime_missing",
      "cannot locate the active @koni/core package root",
    );
  }
  const preloadPath = path.join(coreRoot, "bin", "pi-peer-register.js");
  const loaderPath = path.join(coreRoot, "bin", "pi-peer-loader.js");
  const [registerSource, loaderSource] = await Promise.all([
    readBootstrapSource(preloadPath, "preload"),
    readBootstrapSource(loaderPath, "loader"),
  ]);
  const bootstrap: PiPeerBootstrapBinding = {
    registerPath: preloadPath,
    registerSha256: sha256(registerSource),
    loaderPath,
    loaderSha256: sha256(loaderSource),
  };
  const loaderUrl = javascriptDataUrl(loaderSource);
  const registerModule = replaceBootstrapMarker(
    replaceBootstrapMarker(registerSource.toString("utf8"), LOADER_URL_MARKER, loaderUrl),
    BOOTSTRAP_BINDING_MARKER,
    Buffer.from(JSON.stringify(bootstrap), "utf8").toString("base64url"),
  );
  const preloadUrl = javascriptDataUrl(Buffer.from(registerModule, "utf8"));
  return {
    packageRoot,
    preloadPath,
    preloadUrl,
    nodeArguments: [`--import=${preloadUrl}`],
    environment: { [KONI_PI_PACKAGE_ROOT_ENV]: packageRoot },
  };
}

/**
 * Read a bootstrap module through one no-follow descriptor and bind the exact bytes retained in
 * memory. The child receives only data URLs assembled from this snapshot, so neither bootstrap
 * path is reopened after the authority authenticates its closure.
 */
async function readBootstrapSource(filePath: string, role: "preload" | "loader"): Promise<Buffer> {
  const pathMetadata = await lstat(filePath).catch(() => undefined);
  if (
    pathMetadata === undefined ||
    !pathMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    pathMetadata.size > MAX_BOOTSTRAP_SOURCE_BYTES
  ) {
    throw new PiPeerRuntimeError(
      "pi_peer_preload_missing",
      `@koni/core is missing its authenticated Pi peer ${role}`,
    );
  }
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFile(pathMetadata, before)) {
      throw new PiPeerRuntimeError(
        "pi_peer_preload_changed",
        `@koni/core Pi peer ${role} changed while it was opened`,
      );
    }
    const bytes = await handle.readFile();
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(filePath)]);
    if (
      bytes.byteLength !== before.size ||
      !sameFile(before, afterHandle) ||
      !sameFile(before, afterPath)
    ) {
      throw new PiPeerRuntimeError(
        "pi_peer_preload_changed",
        `@koni/core Pi peer ${role} changed while it was read`,
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function replaceBootstrapMarker(source: string, marker: string, replacement: string): string {
  const first = source.indexOf(marker);
  if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
    throw new PiPeerRuntimeError(
      "pi_peer_preload_template",
      `@koni/core Pi peer preload must contain exactly one ${marker} marker`,
    );
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + marker.length)}`;
}

function javascriptDataUrl(source: Buffer): string {
  return `data:text/javascript;base64,${source.toString("base64")}`;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function ascendToPackage(
  candidate: string,
  expectedName: string,
): Promise<string | undefined> {
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
    throw new PiPeerRuntimeError(
      "pi_package_manifest",
      `cannot read package manifest at ${packageRoot}`,
    );
  }
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.version !== "string") {
    throw new PiPeerRuntimeError(
      "pi_package_manifest",
      `invalid package manifest at ${packageRoot}`,
    );
  }
  return { name: value.name, version: value.version };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
