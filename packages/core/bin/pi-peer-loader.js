import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PI_PEERS = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];
const RUNTIME_PROTOCOL = "koni.runtime-identity.v1";
const STAGE_PROTOCOL = "koni.runtime-stage.v1";
const MAX_PIN_BYTES = 64 * 1024 * 1024;
const MAX_RUNTIME_FILES = 500_000;
const MAX_RUNTIME_DIRECTORIES = 100_000;
const MAX_RUNTIME_RESOLUTIONS = 100_000;

let piParentURL;
let stageRoot;
let originalToStage = new Map();
let stagedFiles = new Map();

export async function initialize(data) {
  assertInitialization(data);
  const pinFields = [data.runtimeClosureSha256, data.runtimePinPath, data.runtimePinSha256];
  const hasPin = pinFields.every((value) => typeof value === "string" && value.length > 0);
  if (!hasPin && pinFields.some((value) => value !== undefined)) {
    throw new Error("Koni runtime stage received a partial closure-pin binding");
  }
  if (!hasPin) {
    piParentURL = pathToFileURL(path.join(data.piPackageRoot, "dist", "index.js")).href;
    return;
  }

  const pinBytes = await readExactFile(data.runtimePinPath, MAX_PIN_BYTES);
  if (sha256(pinBytes) !== data.runtimePinSha256) {
    throw new Error("Koni runtime pin bytes changed before immutable staging");
  }
  let identity;
  try {
    identity = JSON.parse(pinBytes.toString("utf8"));
  } catch {
    throw new Error("Koni runtime pin is not valid JSON");
  }
  validateRuntimeIdentity(identity, data.runtimeClosureSha256);
  validateBootstrapBinding(identity, data.bootstrap);

  stageRoot = runtimeStageRoot(data.runtimePinPath, data.runtimePinSha256);
  await ensureRuntimeStage(stageRoot, identity, data.runtimePinSha256);
  indexStage(stageRoot, identity);
  const stagedPiRoot = stagedRuntimePath(stageRoot, data.piPackageRoot);
  const stagedPiEntry = path.join(stagedPiRoot, "dist", "index.js");
  if (!stagedFiles.has(stagedPiEntry)) {
    throw new Error(
      `authenticated runtime stage does not contain Pi 0.80.10's pinned entry for ${data.piPackageRoot}`,
    );
  }
  piParentURL = pathToFileURL(stagedPiEntry).href;
}

export async function resolve(specifier, context, nextResolve) {
  if (piParentURL === undefined) throw new Error("Koni's Pi peer loader was not initialized");
  if (stageRoot === undefined) {
    if (isPiPeer(specifier)) {
      return nextResolve(specifier, { ...context, parentURL: piParentURL });
    }
    return nextResolve(specifier, context);
  }
  if (specifier.startsWith("node:")) {
    return nextResolve(specifier, context);
  }
  if (specifier.startsWith("data:")) {
    throw new Error("authenticated Koni runtime cannot introduce unpinned data modules");
  }

  const mappedFileSpecifier = mapOriginalFileSpecifier(specifier);
  const absoluteSpecifierPath = fileSpecifierPath(specifier);
  if (
    absoluteSpecifierPath !== undefined &&
    mappedFileSpecifier === undefined &&
    !isPathWithin(stageRoot, absoluteSpecifierPath)
  ) {
    throw new Error(`runtime refused unresolved mutable module path: ${absoluteSpecifierPath}`);
  }
  const mappedSpecifier = mappedFileSpecifier ?? specifier;
  const mappedParent = mapOriginalParent(context.parentURL);
  if (
    context.parentURL !== undefined &&
    context.parentURL.startsWith("file:") &&
    mappedParent === undefined &&
    !isPathWithin(stageRoot, fileURLToPath(context.parentURL))
  ) {
    throw new Error(`runtime refused unresolved mutable parent: ${context.parentURL}`);
  }
  if (
    !isPiPeer(specifier) &&
    context.parentURL === undefined &&
    absoluteSpecifierPath === undefined
  ) {
    throw new Error(`runtime refused an unrooted bare module: ${specifier}`);
  }
  const resolved = await nextResolve(mappedSpecifier, {
    ...context,
    ...(isPiPeer(specifier)
      ? { parentURL: piParentURL }
      : mappedParent === undefined
        ? {}
        : { parentURL: mappedParent }),
  });
  if (resolved.url.startsWith("node:")) return resolved;
  if (!resolved.url.startsWith("file:")) {
    throw new Error(`runtime module escaped authenticated stage: ${resolved.url}`);
  }
  const resolvedPath = fileURLToPath(resolved.url);
  const canonical = await realpath(resolvedPath).catch(() => resolvedPath);
  if (!isPathWithin(stageRoot, canonical) || !stagedFiles.has(canonical)) {
    throw new Error(`runtime module is absent from authenticated stage: ${resolvedPath}`);
  }
  return { ...resolved, url: pathToFileURL(canonical).href };
}

export async function load(url, context, nextLoad) {
  if (stageRoot === undefined || url.startsWith("node:")) {
    return nextLoad(url, context);
  }
  if (url.startsWith("data:")) {
    throw new Error("authenticated Koni runtime cannot load unpinned data modules");
  }
  if (!url.startsWith("file:")) {
    throw new Error(`runtime loader refused non-file module ${url}`);
  }
  const requested = fileURLToPath(url);
  const canonical = await realpath(requested).catch(() => requested);
  const expected = stagedFiles.get(canonical);
  if (expected === undefined || !isPathWithin(stageRoot, canonical)) {
    throw new Error(`runtime loader refused unpinned module ${requested}`);
  }
  const delegated = await nextLoad(pathToFileURL(canonical).href, context);
  if (delegated.format === "builtin") return delegated;
  if (delegated.format === "addon") {
    throw new Error(
      `native addon loading is outside Koni's authenticated source loader: ${requested}`,
    );
  }
  const source = await readStagedFile(canonical, expected);
  return {
    ...delegated,
    source,
    shortCircuit: true,
  };
}

function assertInitialization(data) {
  if (
    !isRecord(data) ||
    typeof data.piPackageRoot !== "string" ||
    !path.isAbsolute(data.piPackageRoot) ||
    !isRecord(data.bootstrap) ||
    typeof data.bootstrap.registerPath !== "string" ||
    !path.isAbsolute(data.bootstrap.registerPath) ||
    typeof data.bootstrap.loaderPath !== "string" ||
    !path.isAbsolute(data.bootstrap.loaderPath) ||
    !isDigest(data.bootstrap.registerSha256) ||
    !isDigest(data.bootstrap.loaderSha256)
  ) {
    throw new Error("Koni's Pi peer loader received an invalid immutable bootstrap binding");
  }
}

function validateRuntimeIdentity(identity, expectedClosure) {
  if (
    !isRecord(identity) ||
    identity.protocol !== RUNTIME_PROTOCOL ||
    identity.closureSha256 !== expectedClosure ||
    identity.nodeVersion !== process.versions.node ||
    identity.platform !== process.platform ||
    identity.architecture !== process.arch ||
    !Array.isArray(identity.files) ||
    !Array.isArray(identity.directories) ||
    !Array.isArray(identity.resolutions) ||
    identity.files.length > MAX_RUNTIME_FILES ||
    identity.directories.length > MAX_RUNTIME_DIRECTORIES ||
    identity.resolutions.length > MAX_RUNTIME_RESOLUTIONS
  ) {
    throw new Error("Koni runtime pin has an invalid or incompatible closure identity");
  }
  const paths = new Set();
  for (const file of identity.files) {
    if (
      !isRecord(file) ||
      typeof file.path !== "string" ||
      !path.isAbsolute(file.path) ||
      (file.kind !== "file" && file.kind !== "symlink") ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      paths.has(file.path) ||
      (file.kind === "file" && !isDigest(file.contentSha256)) ||
      (file.kind === "symlink" && typeof file.linkTarget !== "string")
    ) {
      throw new Error("Koni runtime pin contains an invalid or duplicate file identity");
    }
    paths.add(file.path);
  }
  for (const directory of identity.directories) {
    if (
      !isRecord(directory) ||
      typeof directory.path !== "string" ||
      !path.isAbsolute(directory.path)
    ) {
      throw new Error("Koni runtime pin contains an invalid directory identity");
    }
  }
  const resolutionKeys = new Set();
  for (const resolution of identity.resolutions) {
    const key = isRecord(resolution)
      ? `${resolution.parentPackageRoot}\0${resolution.dependency}`
      : "";
    if (
      !isRecord(resolution) ||
      typeof resolution.parentPackageRoot !== "string" ||
      !path.isAbsolute(resolution.parentPackageRoot) ||
      typeof resolution.packageRoot !== "string" ||
      !path.isAbsolute(resolution.packageRoot) ||
      typeof resolution.dependency !== "string" ||
      !isPackageName(resolution.dependency) ||
      resolutionKeys.has(key)
    ) {
      throw new Error("Koni runtime pin contains an invalid or duplicate dependency resolution");
    }
    resolutionKeys.add(key);
  }
}

function validateBootstrapBinding(identity, bootstrap) {
  const byPath = new Map(identity.files.map((file) => [file.path, file]));
  const register = byPath.get(bootstrap.registerPath);
  const loader = byPath.get(bootstrap.loaderPath);
  if (
    register?.kind !== "file" ||
    loader?.kind !== "file" ||
    register.contentSha256 !== bootstrap.registerSha256 ||
    loader.contentSha256 !== bootstrap.loaderSha256
  ) {
    throw new Error("executing Pi preload/loader bytes do not match the authority closure pin");
  }
}

async function ensureRuntimeStage(target, identity, pinSha256) {
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const existing = await lstat(target).catch(() => undefined);
  if (existing !== undefined) {
    await verifyStageSeal(target, identity, pinSha256);
    return;
  }

  const temporary = path.join(parent, `.${path.basename(target)}.${process.pid}.${randomUUID()}`);
  try {
    await mkdir(path.join(temporary, "fs"), { recursive: true, mode: 0o700 });
    const orderedDirectories = [...identity.directories].sort(
      (left, right) => left.path.length - right.path.length || compareText(left.path, right.path),
    );
    await mapLimit(orderedDirectories, 64, async (directory) => {
      const destination = stagedRuntimePath(temporary, directory.path);
      await mkdir(destination, { recursive: true, mode: 0o700 });
    });

    const regularFiles = identity.files
      .filter((file) => file.kind === "file")
      .sort((left, right) => compareText(left.path, right.path));
    await mapLimit(regularFiles, 64, async (file) => {
      const destination = stagedRuntimePath(temporary, file.path);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const bytes = await readOriginalRuntimeFile(file);
      await writeFile(destination, bytes, { flag: "wx", mode: 0o400 });
      await chmod(destination, 0o400);
    });

    const links = identity.files
      .filter((file) => file.kind === "symlink")
      .sort((left, right) => compareText(left.path, right.path));
    await mapLimit(links, 64, async (file) => {
      const destination = stagedRuntimePath(temporary, file.path);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const target = stagedSymlinkTarget(temporary, file.path, file.linkTarget);
      await symlink(target, destination);
    });

    const resolutions = [...identity.resolutions].sort(
      (left, right) =>
        compareText(left.parentPackageRoot, right.parentPackageRoot) ||
        compareText(left.dependency, right.dependency),
    );
    await mapLimit(resolutions, 64, async (resolution) => {
      const destination = stagedDependencyLink(temporary, resolution);
      const packageRoot = stagedRuntimePath(temporary, resolution.packageRoot);
      if (path.normalize(destination) === path.normalize(packageRoot)) return;
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const target = path.relative(path.dirname(destination), packageRoot);
      await symlink(target, destination);
    });

    const seal = Buffer.from(
      `${JSON.stringify({
        protocol: STAGE_PROTOCOL,
        pinSha256,
        closureSha256: identity.closureSha256,
        fileCount: identity.files.length,
        directoryCount: identity.directories.length,
        resolutionCount: identity.resolutions.length,
      })}\n`,
      "utf8",
    );
    await writeFile(path.join(temporary, ".koni-runtime-stage.json"), seal, {
      flag: "wx",
      mode: 0o400,
    });
    await chmod(path.join(temporary, ".koni-runtime-stage.json"), 0o400);
    await chmodStageDirectories(temporary, 0o500);
    try {
      await rename(temporary, target);
    } catch (error) {
      // macOS may report EACCES/EPERM (rather than EEXIST/ENOTEMPTY) when another process won
      // the atomic directory publication race and sealed the destination tree to 0500. Treat
      // those codes only as a possible collision: the winner still has to pass the complete seal
      // and byte verification below, so a genuine permission failure remains fail-closed.
      if (
        !hasCode(error, "EEXIST") &&
        !hasCode(error, "ENOTEMPTY") &&
        !hasCode(error, "EACCES") &&
        !hasCode(error, "EPERM")
      )
        throw error;
      await verifyStageSeal(target, identity, pinSha256);
    }
  } finally {
    await chmodStageDirectories(temporary, 0o700).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
  await verifyStageSeal(target, identity, pinSha256);
}

async function verifyStageSeal(target, identity, pinSha256) {
  const metadata = await lstat(target).catch(() => undefined);
  if (
    metadata === undefined ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o500
  ) {
    throw new Error("Koni runtime stage path is missing or unsafe");
  }
  const bytes = await readExactFile(
    path.join(target, ".koni-runtime-stage.json"),
    16 * 1024,
    0o400,
  );
  let seal;
  try {
    seal = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Koni runtime stage seal is invalid JSON");
  }
  if (
    !isRecord(seal) ||
    seal.protocol !== STAGE_PROTOCOL ||
    seal.pinSha256 !== pinSha256 ||
    seal.closureSha256 !== identity.closureSha256 ||
    seal.fileCount !== identity.files.length ||
    seal.directoryCount !== identity.directories.length ||
    seal.resolutionCount !== identity.resolutions.length
  ) {
    throw new Error("Koni runtime stage seal differs from the authority pin");
  }
  await assertStageDirectoryModes(target);
  await verifyStageContent(target, identity);
}

async function verifyStageContent(root, identity) {
  await mapLimit(identity.files, 64, async (file) => {
    const staged = stagedRuntimePath(root, file.path);
    if (file.kind === "file") {
      await readStagedFile(staged, file);
      return;
    }
    const metadata = await lstat(staged).catch(() => undefined);
    const expectedTarget = stagedSymlinkTarget(root, file.path, file.linkTarget);
    if (
      metadata === undefined ||
      !metadata.isSymbolicLink() ||
      (await readlink(staged).catch(() => undefined)) !== expectedTarget
    ) {
      throw new Error(`authenticated runtime stage symlink changed: ${file.path}`);
    }
  });
  await mapLimit(identity.resolutions, 64, async (resolution) => {
    const link = stagedDependencyLink(root, resolution);
    const packageRoot = stagedRuntimePath(root, resolution.packageRoot);
    if (path.normalize(link) === path.normalize(packageRoot)) {
      const metadata = await lstat(packageRoot).catch(() => undefined);
      if (
        metadata === undefined ||
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o777) !== 0o500
      ) {
        throw new Error(`authenticated runtime dependency root changed: ${resolution.dependency}`);
      }
      return;
    }
    const metadata = await lstat(link).catch(() => undefined);
    const expectedTarget = path.relative(path.dirname(link), packageRoot);
    if (
      metadata === undefined ||
      !metadata.isSymbolicLink() ||
      (await readlink(link).catch(() => undefined)) !== expectedTarget
    ) {
      throw new Error(
        `authenticated runtime dependency resolution changed: ${resolution.dependency}`,
      );
    }
  });
}

async function mapLimit(values, concurrency, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      await operation(values[index]);
    }
  });
  await Promise.all(workers);
}

async function chmodStageDirectories(root, mode) {
  const metadata = await lstat(root).catch(() => undefined);
  if (metadata === undefined) return;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`runtime stage contains an unsafe directory path: ${root}`);
  }
  if ((mode & 0o200) !== 0) await chmod(root, mode);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await chmodStageDirectories(path.join(root, entry.name), mode);
    }
  }
  if ((mode & 0o200) === 0) await chmod(root, mode);
}

async function assertStageDirectoryModes(root) {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o500) {
    throw new Error(`runtime stage directory is writable or unsafe: ${root}`);
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await assertStageDirectoryModes(path.join(root, entry.name));
    }
  }
}

function indexStage(root, identity) {
  originalToStage = new Map();
  stagedFiles = new Map();
  for (const file of identity.files) {
    const staged = stagedRuntimePath(root, file.path);
    originalToStage.set(path.normalize(file.path), staged);
    if (file.kind === "file") stagedFiles.set(staged, file);
  }
  for (const file of identity.files) {
    if (file.kind !== "symlink") continue;
    const originalTarget = path.resolve(path.dirname(file.path), file.linkTarget);
    const target = originalToStage.get(path.normalize(originalTarget));
    if (target !== undefined)
      stagedFiles.set(stagedRuntimePath(root, file.path), stagedFiles.get(target));
  }
}

async function readOriginalRuntimeFile(file) {
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== file.size) {
      throw new Error(`runtime source changed before staging: ${file.path}`);
    }
    const bytes = await handle.readFile();
    const afterHandle = await handle.stat();
    const afterPath = await lstat(file.path);
    if (
      !sameFile(before, afterHandle) ||
      !sameFile(before, afterPath) ||
      sha256(bytes) !== file.contentSha256
    ) {
      throw new Error(`runtime source bytes changed before staging: ${file.path}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readStagedFile(filePath, expected) {
  const bytes = await readExactFile(filePath, expected.size, 0o400);
  if (bytes.byteLength !== expected.size || sha256(bytes) !== expected.contentSha256) {
    throw new Error(`authenticated runtime stage bytes changed: ${filePath}`);
  }
  return bytes;
}

async function readExactFile(filePath, maximum, expectedMode) {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size > maximum ||
      (expectedMode !== undefined && (before.mode & 0o777) !== expectedMode)
    ) {
      throw new Error(`unsafe runtime file ${filePath}`);
    }
    const bytes = await handle.readFile();
    const afterHandle = await handle.stat();
    const afterPath = await lstat(filePath);
    if (!sameFile(before, afterHandle) || !sameFile(before, afterPath)) {
      throw new Error(`runtime file changed while read: ${filePath}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function mapOriginalFileSpecifier(specifier) {
  const original = fileSpecifierPath(specifier);
  if (original === undefined) return undefined;
  const staged = originalToStage.get(path.normalize(original));
  return staged === undefined ? undefined : pathToFileURL(staged).href;
}

function fileSpecifierPath(specifier) {
  try {
    if (specifier.startsWith("file:")) return fileURLToPath(specifier);
    if (path.isAbsolute(specifier)) return specifier;
  } catch {
    return undefined;
  }
  return undefined;
}

function mapOriginalParent(parentURL) {
  if (parentURL === undefined || !parentURL.startsWith("file:")) return undefined;
  const staged = originalToStage.get(path.normalize(fileURLToPath(parentURL)));
  return staged === undefined ? undefined : pathToFileURL(staged).href;
}

function runtimeStageRoot(pinPath, pinSha256) {
  return path.join(
    path.dirname(path.dirname(pinPath)),
    "runtime-stages",
    pinSha256.slice("sha256:".length),
  );
}

function stagedRuntimePath(root, originalPath) {
  const parsed = path.parse(originalPath);
  const rootKey = Buffer.from(parsed.root, "utf8").toString("base64url");
  const relative = path.relative(parsed.root, originalPath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`cannot mirror runtime path ${originalPath}`);
  }
  return path.join(root, "fs", rootKey, relative);
}

function stagedSymlinkTarget(root, originalPath, linkTarget) {
  const originalTarget = path.resolve(path.dirname(originalPath), linkTarget);
  return path.relative(
    path.dirname(stagedRuntimePath(root, originalPath)),
    stagedRuntimePath(root, originalTarget),
  );
}

function stagedDependencyLink(root, resolution) {
  return path.join(
    stagedRuntimePath(root, resolution.parentPackageRoot),
    "node_modules",
    ...resolution.dependency.split("/"),
  );
}

function sameFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function isPiPeer(specifier) {
  return PI_PEERS.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

function isPathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPackageName(value) {
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/.test(value);
}

function hasCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
