import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const piPackageRoot = process.env.KONI_PI_PACKAGE_ROOT;
if (!piPackageRoot) {
  throw new Error("KONI_PI_PACKAGE_ROOT is required before loading Koni's Pi peer bridge");
}

// `resolvePiPeerRuntime()` replaces each sentinel exactly once and passes the resulting module as
// a data URL. Direct execution remains valid for Pi's interactive parent process; provider-capable
// authorities and attempts always take the embedded branch.
let loaderUrl = "__KONI_PI_PEER_LOADER_URL__";
const embeddedBootstrap = "__KONI_PI_PEER_BOOTSTRAP_BINDING__";
let bootstrap;
if (loaderUrl.startsWith("data:")) {
  bootstrap = JSON.parse(Buffer.from(embeddedBootstrap, "base64url").toString("utf8"));
} else {
  const registerPath = fileURLToPath(import.meta.url);
  const loaderPath = fileURLToPath(new URL("./pi-peer-loader.js", import.meta.url));
  const [registerSource, loaderSource] = await Promise.all([
    readFile(registerPath),
    readFile(loaderPath),
  ]);
  loaderUrl = new URL("./pi-peer-loader.js", import.meta.url).href;
  bootstrap = {
    registerPath,
    registerSha256: sha256(registerSource),
    loaderPath,
    loaderSha256: sha256(loaderSource),
  };
}
const runtimeClosureSha256 = process.env.KONI_RUNTIME_CLOSURE_SHA256;
const runtimePinPath = process.env.KONI_RUNTIME_PIN_PATH;
const runtimePinSha256 = process.env.KONI_RUNTIME_PIN_SHA256;

register(loaderUrl, {
  parentURL: import.meta.url,
  data: {
    piPackageRoot,
    runtimeClosureSha256,
    runtimePinPath,
    runtimePinSha256,
    bootstrap,
  },
});

// Main-thread code must discover dependencies through the staged topology as well. The loader
// retains the original path only as an authenticated staging source; no later Koni code receives
// or resolves that mutable root.
if (runtimePinPath && /^sha256:[0-9a-f]{64}$/u.test(runtimePinSha256 ?? "")) {
  const stageRoot = path.join(
    path.dirname(path.dirname(runtimePinPath)),
    "runtime-stages",
    runtimePinSha256.slice("sha256:".length),
  );
  process.env.KONI_PI_PACKAGE_ROOT = stagedRuntimePath(stageRoot, piPackageRoot);
  const requestedEntry = process.argv[1];
  if (requestedEntry !== undefined && path.isAbsolute(requestedEntry)) {
    // Node preserves the original argv entry even when the loader maps the main module. Point the
    // direct-invocation guard at the same immutable file so `koni authority serve` cannot silently
    // exit merely because its authenticated entry has a different physical pathname.
    process.argv[1] = stagedRuntimePath(stageRoot, realpathSync(requestedEntry));
  }
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function stagedRuntimePath(stageRoot, originalPath) {
  const parsed = path.parse(originalPath);
  const rootKey = Buffer.from(parsed.root, "utf8").toString("base64url");
  const relative = path.relative(parsed.root, originalPath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Koni cannot map authenticated runtime path ${originalPath} into its stage`);
  }
  return path.join(stageRoot, "fs", rootKey, relative);
}
