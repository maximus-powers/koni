import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const ACTIVATION_PROTOCOL = "koni.global-launcher.v1" as const;
const JOURNAL_PROTOCOL = "koni.global-launcher-journal.v1" as const;
const PACKAGE_RELATIVE_PATH = path.join("npm", "node_modules", "@koni", "core");

export type GlobalLauncherMutationPoint =
  | "before_launcher_rename"
  | "after_launcher_rename"
  | "before_launcher_unlink"
  | "after_launcher_displaced_validation"
  | "after_launcher_removal_validation"
  | "after_recovery_target_containment"
  | "before_marker_rename"
  | "after_marker_rename";

export const GLOBAL_LAUNCHER_TEST_HOOK = Symbol("koni.global-launcher.test-hook");

export interface GlobalLauncherEnvironment {
  packageRoot: string;
  agentDir: string;
  pathValue: string;
  platform: NodeJS.Platform;
}

export interface GlobalLauncherActivation {
  protocol: "koni.global-launcher.v1";
  launcherPath: string;
  packageRoot: string;
  launcherTarget: string;
  targetSha256: string;
  launcherSha256: string;
}

type LauncherIdentity = Omit<GlobalLauncherActivation, "launcherSha256"> & {
  markerPath: string;
  argumentOffset: number;
};

interface ActivationJournal {
  protocol: "koni.global-launcher-journal.v1";
  operation: "activate";
  previous: GlobalLauncherActivation | null;
  next: GlobalLauncherActivation;
  displacedPath: string | null;
}

type HookedEnvironment = GlobalLauncherEnvironment & {
  [GLOBAL_LAUNCHER_TEST_HOOK]?: (point: GlobalLauncherMutationPoint) => void | Promise<void>;
};

export function isPiUserPackageInstallation(input: {
  packageRoot: string;
  agentDir: string;
}): boolean {
  const packageRoot = path.resolve(input.packageRoot);
  const agentDir = path.resolve(input.agentDir);
  const expectedRoot = path.join(agentDir, PACKAGE_RELATIVE_PATH);
  if (!isWithin(expectedRoot, packageRoot)) return false;
  try {
    const physicalAgentDir = path.resolve(requireRealpath(input.agentDir));
    return isWithin(
      path.join(physicalAgentDir, PACKAGE_RELATIVE_PATH),
      requireRealpath(input.packageRoot),
    );
  } catch {
    return false;
  }
}

export async function activateGlobalLauncher(
  environment: GlobalLauncherEnvironment,
): Promise<GlobalLauncherActivation | undefined> {
  if (!isPiUserPackageInstallation(environment)) return undefined;

  const piExecutable = await findSolePiExecutable(environment);
  const launcherPath = path.join(
    path.dirname(piExecutable),
    environment.platform === "win32" ? "koni.cmd" : "koni",
  );
  await assertWritableDirectory(path.dirname(launcherPath), "Pi launcher");
  const markerDirectory = path.join(path.resolve(environment.agentDir), "koni");
  await ensurePrivateMarkerDirectory(environment.agentDir, markerDirectory);
  const markerPath = path.join(markerDirectory, "global-launcher.json");
  const journalPath = path.join(markerDirectory, "global-launcher.pending.json");
  const activation = await activationFor(environment, launcherPath, markerPath);
  await recoverPendingActivation(environment, markerPath, journalPath, launcherPath);
  const marker = await readOwnershipMarker(markerPath, environment, launcherPath);
  const launcherExists = await pathExistsNoFollow(launcherPath);
  if (marker === "malformed") {
    throw new Error(`refusing malformed global launcher marker at ${markerPath}`);
  }
  if (marker === undefined) {
    if (launcherExists) {
      throw new Error(`refusing to overwrite an unrelated koni launcher at ${launcherPath}`);
    }
  } else {
    const authenticated =
      launcherExists &&
      (await launcherMatches(marker, environment.platform)) &&
      launcherDigestMatchesContent(marker, environment.platform, markerPath) &&
      ((await targetMatchesDigest(marker)) || sameTargetIdentity(marker, activation));
    if (!authenticated) {
      throw new Error(`refusing to overwrite an unrelated koni launcher at ${launcherPath}`);
    }
    if (sameActivation(marker, activation)) return activation;
  }

  const journal: ActivationJournal = {
    protocol: JOURNAL_PROTOCOL,
    operation: "activate",
    previous: marker ?? null,
    next: activation,
    displacedPath: marker === undefined ? null : adjacentTemporary(launcherPath),
  };
  await publishFileAtomically(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
  await publishLauncherConditionally(
    activation,
    marker ?? null,
    environment,
    true,
    journal.displacedPath ?? undefined,
  );
  await publishFileAtomically(markerPath, `${JSON.stringify(activation, null, 2)}\n`, 0o600, {
    before: "before_marker_rename",
    after: "after_marker_rename",
    environment,
  });
  await unlink(journalPath);
  await syncDirectory(markerDirectory);
  return activation;
}

export async function removeGlobalLauncher(
  environment: GlobalLauncherEnvironment,
): Promise<"removed" | "absent" | "not_owner"> {
  if (!isPiUserPackageInstallation(environment)) return "absent";
  const piExecutable = await findSolePiExecutable(environment);
  const launcherPath = path.join(
    path.dirname(piExecutable),
    environment.platform === "win32" ? "koni.cmd" : "koni",
  );
  const markerDirectory = path.join(path.resolve(environment.agentDir), "koni");
  const markerPath = path.join(markerDirectory, "global-launcher.json");
  const journalPath = path.join(markerDirectory, "global-launcher.pending.json");
  const markerDirectoryState = await existingMarkerDirectoryState(
    environment.agentDir,
    markerDirectory,
  );
  if (markerDirectoryState === "unsafe") return "not_owner";
  if (markerDirectoryState === "absent") {
    return (await pathExistsNoFollow(launcherPath)) ? "not_owner" : "absent";
  }
  await recoverPendingActivation(environment, markerPath, journalPath, launcherPath);
  const marker = await readOwnershipMarker(markerPath, environment, launcherPath);
  const launcherExists = await pathExistsNoFollow(launcherPath);
  if (marker === undefined) return launcherExists ? "not_owner" : "absent";
  if (marker === "malformed" || marker.packageRoot !== path.resolve(environment.packageRoot)) {
    return "not_owner";
  }
  const current = await activationFor(environment, launcherPath, markerPath);
  if (!sameActivation(marker, current) || !(await targetMatchesDigest(marker))) return "not_owner";
  if (launcherExists && !(await launcherMatches(marker, environment.platform))) return "not_owner";
  if (launcherExists) {
    await callMutationHook(environment, "before_launcher_unlink");
    if (!(await removeLauncherIfOwned(marker, environment))) return "not_owner";
  }
  await unlink(markerPath);
  await syncDirectory(path.dirname(launcherPath));
  await syncDirectory(path.dirname(markerPath));
  return "removed";
}

async function recoverPendingActivation(
  environment: GlobalLauncherEnvironment,
  markerPath: string,
  journalPath: string,
  launcherPath: string,
): Promise<void> {
  const journal = await readActivationJournal(journalPath, environment, launcherPath);
  if (journal === undefined) return;
  if (journal === "malformed") {
    throw new Error(`refusing malformed global launcher journal at ${journalPath}`);
  }
  if (
    !launcherDigestMatchesContent(journal.next, environment.platform, markerPath) ||
    (journal.previous !== null &&
      !launcherDigestMatchesContent(journal.previous, environment.platform, markerPath))
  ) {
    throw new Error(`refusing malformed global launcher journal at ${journalPath}`);
  }
  const nextDigest = await digestTargetWithinPackage(
    journal.next.launcherTarget,
    journal.next.packageRoot,
    environment,
  );
  if (nextDigest !== journal.next.targetSha256) {
    throw new Error("refusing global launcher recovery because its intended target changed");
  }
  if (
    journal.previous !== null &&
    !sameTargetIdentity(journal.previous, journal.next) &&
    (await digestTargetWithinPackage(
      journal.previous.launcherTarget,
      journal.previous.packageRoot,
    )) !== journal.previous.targetSha256
  ) {
    throw new Error("refusing global launcher recovery because its previous target changed");
  }
  const marker = await readOwnershipMarker(markerPath, environment, launcherPath);
  if (
    marker === "malformed" ||
    (marker !== undefined &&
      !sameActivation(marker, journal.next) &&
      (journal.previous === null || !sameActivation(marker, journal.previous)))
  ) {
    throw new Error("refusing global launcher recovery because the ownership marker changed");
  }

  const launcherExists = await pathExistsNoFollow(launcherPath);
  const launcherIsNext =
    launcherExists && (await launcherMatches(journal.next, environment.platform));
  const launcherIsPrevious =
    launcherExists &&
    journal.previous !== null &&
    (await launcherMatches(journal.previous, environment.platform));
  const displacedIsPrevious =
    journal.previous !== null &&
    journal.displacedPath !== null &&
    (await launcherMatches(atPath(journal.previous, journal.displacedPath), environment.platform));
  if (
    !launcherIsNext &&
    !launcherIsPrevious &&
    (launcherExists || (journal.previous !== null && !displacedIsPrevious))
  ) {
    throw new Error(`refusing to overwrite an unrelated koni launcher at ${launcherPath}`);
  }
  if (!launcherIsNext) {
    await publishLauncherConditionally(
      journal.next,
      launcherIsPrevious ? journal.previous : null,
      environment,
      false,
      journal.displacedPath ?? undefined,
    );
  }
  if (marker === undefined || !sameActivation(marker, journal.next)) {
    await publishFileAtomically(markerPath, `${JSON.stringify(journal.next, null, 2)}\n`, 0o600);
  }
  await unlink(journalPath);
  await syncDirectory(path.dirname(journalPath));
}

async function activationFor(
  environment: GlobalLauncherEnvironment,
  launcherPath: string,
  markerPath: string,
): Promise<GlobalLauncherActivation> {
  const packageRoot = path.resolve(environment.packageRoot);
  const launcherTarget = path.join(packageRoot, "bin", "koni.js");
  const activation: Omit<GlobalLauncherActivation, "launcherSha256"> = {
    protocol: ACTIVATION_PROTOCOL,
    launcherPath,
    packageRoot,
    launcherTarget,
    targetSha256: await digestTargetWithinPackage(launcherTarget, packageRoot),
  };
  return {
    ...activation,
    launcherSha256: createHash("sha256")
      .update(launcherContent(activation, environment.platform, markerPath))
      .digest("hex"),
  };
}

async function findSolePiExecutable(environment: GlobalLauncherEnvironment): Promise<string> {
  const names =
    environment.platform === "win32" ? ["pi.com", "pi.exe", "pi.bat", "pi.cmd"] : ["pi"];
  const delimiter = environment.platform === "win32" ? ";" : ":";
  const matches = new Map<string, string>();
  for (const directory of environment.pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.resolve(directory, name);
      try {
        const metadata = await stat(candidate);
        if (!metadata.isFile()) continue;
        if (environment.platform !== "win32") await access(candidate, constants.X_OK);
        const physical = await realpath(candidate);
        if (!matches.has(physical)) matches.set(physical, candidate);
        if (environment.platform === "win32") break;
      } catch {
        // A PATH entry is a candidate only when it names a runnable regular file.
      }
    }
  }
  if (matches.size === 0) throw new Error("could not locate Pi on PATH");
  if (matches.size !== 1) throw new Error("refusing ambiguous Pi executables on PATH");
  return [...matches.values()][0]!;
}

async function digestTargetWithinPackage(
  target: string,
  packageRoot: string,
  hookEnvironment?: GlobalLauncherEnvironment,
): Promise<string> {
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new Error(`the Koni launcher target is not a regular file: ${target}`);
    }
    await assertOpenedTargetIdentity(target, packageRoot, opened.dev, opened.ino);
    if (hookEnvironment !== undefined) {
      await callMutationHook(hookEnvironment, "after_recovery_target_containment");
    }
    const bytes = await handle.readFile();
    await assertOpenedTargetIdentity(target, packageRoot, opened.dev, opened.ino);
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    await handle.close();
  }
}

async function assertOpenedTargetIdentity(
  target: string,
  packageRoot: string,
  openedDevice: number,
  openedInode: number,
): Promise<void> {
  const physicalRoot = await realpath(packageRoot);
  const physicalTarget = await realpath(target);
  if (path.dirname(physicalTarget) !== path.join(physicalRoot, "bin")) {
    throw new Error(`the Koni launcher target escapes its package: ${target}`);
  }
  const current = await stat(physicalTarget);
  if (current.dev !== openedDevice || current.ino !== openedInode) {
    throw new Error(`the Koni launcher target changed during authentication: ${target}`);
  }
}

async function readOwnershipMarker(
  markerPath: string,
  environment: GlobalLauncherEnvironment,
  launcherPath: string,
): Promise<GlobalLauncherActivation | "malformed" | undefined> {
  let handle;
  try {
    handle = await open(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    return "malformed";
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 64 * 1024) return "malformed";
    const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!isActivationRecord(parsed)) return "malformed";
    if (parsed.launcherPath !== launcherPath) return "malformed";
    if (
      !isPiUserPackageInstallation({
        packageRoot: parsed.packageRoot,
        agentDir: environment.agentDir,
      })
    ) {
      return "malformed";
    }
    if (parsed.launcherTarget !== path.join(parsed.packageRoot, "bin", "koni.js")) {
      return "malformed";
    }
    return parsed;
  } catch {
    return "malformed";
  } finally {
    await handle.close();
  }
}

async function readActivationJournal(
  journalPath: string,
  environment: GlobalLauncherEnvironment,
  launcherPath: string,
): Promise<ActivationJournal | "malformed" | undefined> {
  const value = await readBoundedJsonNoFollow(journalPath);
  if (value === undefined || value === "malformed") return value;
  if (typeof value !== "object" || value === null) return "malformed";
  const record = value as Record<string, unknown>;
  if (
    record.protocol !== JOURNAL_PROTOCOL ||
    record.operation !== "activate" ||
    !isActivationRecord(record.next) ||
    (record.previous !== null && !isActivationRecord(record.previous)) ||
    (record.previous === null
      ? record.displacedPath !== null
      : typeof record.displacedPath !== "string" ||
        !isAdjacentTemporaryFor(record.next.launcherPath, record.displacedPath))
  ) {
    return "malformed";
  }
  const journal = record as unknown as ActivationJournal;
  const activations = journal.previous === null ? [journal.next] : [journal.previous, journal.next];
  if (
    activations.some(
      (activation) =>
        activation.launcherPath !== launcherPath ||
        activation.launcherTarget !== path.join(activation.packageRoot, "bin", "koni.js") ||
        !isPiUserPackageInstallation({
          packageRoot: activation.packageRoot,
          agentDir: environment.agentDir,
        }),
    )
  ) {
    return "malformed";
  }
  return journal;
}

async function readBoundedJsonNoFollow(source: string): Promise<unknown | "malformed" | undefined> {
  let handle;
  try {
    handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    return "malformed";
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 64 * 1024) return "malformed";
    return JSON.parse(await handle.readFile("utf8"));
  } catch {
    return "malformed";
  } finally {
    await handle.close();
  }
}

function isActivationRecord(value: unknown): value is GlobalLauncherActivation {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.protocol === ACTIVATION_PROTOCOL &&
    typeof record.launcherPath === "string" &&
    path.isAbsolute(record.launcherPath) &&
    typeof record.packageRoot === "string" &&
    path.isAbsolute(record.packageRoot) &&
    typeof record.launcherTarget === "string" &&
    path.isAbsolute(record.launcherTarget) &&
    typeof record.targetSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(record.targetSha256) &&
    typeof record.launcherSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(record.launcherSha256)
  );
}

async function launcherMatches(
  activation: GlobalLauncherActivation,
  _platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    const metadata = await lstat(activation.launcherPath);
    return (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      createHash("sha256")
        .update(await readFile(activation.launcherPath))
        .digest("hex") === activation.launcherSha256
    );
  } catch {
    return false;
  }
}

async function targetMatchesDigest(activation: GlobalLauncherActivation): Promise<boolean> {
  try {
    const digest = await digestTargetWithinPackage(
      activation.launcherTarget,
      activation.packageRoot,
    );
    return digest === activation.targetSha256;
  } catch {
    return false;
  }
}

function sameTargetIdentity(
  left: GlobalLauncherActivation,
  right: GlobalLauncherActivation,
): boolean {
  return left.packageRoot === right.packageRoot && left.launcherTarget === right.launcherTarget;
}

function sameActivation(left: GlobalLauncherActivation, right: GlobalLauncherActivation): boolean {
  return (
    left.protocol === right.protocol &&
    left.launcherPath === right.launcherPath &&
    sameTargetIdentity(left, right) &&
    left.targetSha256 === right.targetSha256 &&
    left.launcherSha256 === right.launcherSha256
  );
}

function launcherDigestMatchesContent(
  activation: GlobalLauncherActivation,
  platform: NodeJS.Platform,
  markerPath: string,
): boolean {
  return (
    createHash("sha256")
      .update(launcherContent(activation, platform, markerPath))
      .digest("hex") === activation.launcherSha256
  );
}

async function ensurePrivateMarkerDirectory(
  agentDir: string,
  markerDirectory: string,
): Promise<void> {
  const created = await mkdir(markerDirectory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(markerDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      `the global launcher marker directory is not a private directory: ${markerDirectory}`,
    );
  }
  const physicalAgentDir = await realpath(agentDir);
  if ((await realpath(markerDirectory)) !== path.join(physicalAgentDir, "koni")) {
    throw new Error(`the global launcher marker directory escapes the Pi agent directory`);
  }
  await assertWritableDirectory(markerDirectory, "global launcher marker");
  if (created !== undefined) await chmod(markerDirectory, 0o700);
}

async function existingMarkerDirectoryState(
  agentDir: string,
  markerDirectory: string,
): Promise<"safe" | "absent" | "unsafe"> {
  try {
    const metadata = await lstat(markerDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return "unsafe";
    const physicalAgentDir = await realpath(agentDir);
    return (await realpath(markerDirectory)) === path.join(physicalAgentDir, "koni")
      ? "safe"
      : "unsafe";
  } catch (error) {
    return isCode(error, "ENOENT") ? "absent" : "unsafe";
  }
}

async function assertWritableDirectory(directory: string, label: string): Promise<void> {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("not a directory");
    await access(directory, constants.W_OK);
  } catch {
    throw new Error(`${label} directory is not writable: ${directory}`);
  }
}

async function publishLauncherConditionally(
  activation: GlobalLauncherActivation,
  previous: GlobalLauncherActivation | null,
  environment: GlobalLauncherEnvironment,
  invokeHooks = true,
  intendedDisplacedPath?: string,
): Promise<void> {
  const temporary = adjacentTemporary(activation.launcherPath);
  let displaced: string | undefined;
  try {
    await writeFile(
      temporary,
      launcherContent(
        activation,
        environment.platform,
        path.join(path.resolve(environment.agentDir), "koni", "global-launcher.json"),
      ),
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o755,
      },
    );
    if (invokeHooks) await callMutationHook(environment, "before_launcher_rename");
    if (previous !== null) {
      displaced = intendedDisplacedPath ?? adjacentTemporary(activation.launcherPath);
      try {
        await rename(activation.launcherPath, displaced);
      } catch {
        throw unrelatedLauncherError(activation.launcherPath);
      }
      if (!(await launcherMatches(atPath(previous, displaced), environment.platform))) {
        await restoreNoReplace(displaced, activation.launcherPath);
        displaced = undefined;
        throw unrelatedLauncherError(activation.launcherPath);
      }
      await callMutationHook(environment, "after_launcher_displaced_validation");
    }
    try {
      await publishNoReplace(temporary, activation.launcherPath);
    } catch (error) {
      if (displaced !== undefined) {
        await restoreNoReplace(displaced, activation.launcherPath);
        displaced = undefined;
      }
      if (isCode(error, "EEXIST")) throw unrelatedLauncherError(activation.launcherPath);
      throw error;
    }
    if (displaced !== undefined) {
      displaced = undefined;
    }
    if (invokeHooks) await callMutationHook(environment, "after_launcher_rename");
    await syncDirectory(path.dirname(activation.launcherPath));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function removeLauncherIfOwned(
  activation: GlobalLauncherActivation,
  environment: GlobalLauncherEnvironment,
): Promise<boolean> {
  const displaced = adjacentTemporary(activation.launcherPath);
  try {
    await rename(activation.launcherPath, displaced);
  } catch {
    return false;
  }
  if (!(await launcherMatches(atPath(activation, displaced), environment.platform))) {
    await restoreNoReplace(displaced, activation.launcherPath);
    return false;
  }
  await callMutationHook(environment, "after_launcher_removal_validation");
  return true;
}

async function publishNoReplace(source: string, destination: string): Promise<void> {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`refusing to publish a non-regular launcher from ${source}`);
  }
  await link(source, destination);
  await unlink(source);
}

async function restoreNoReplace(source: string, destination: string): Promise<void> {
  try {
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return;
    await link(source, destination);
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  }
}

function atPath(
  activation: GlobalLauncherActivation,
  launcherPath: string,
): GlobalLauncherActivation {
  return { ...activation, launcherPath };
}

function unrelatedLauncherError(launcherPath: string): Error {
  return new Error(`refusing to overwrite an unrelated koni launcher at ${launcherPath}`);
}

async function publishFileAtomically(
  destination: string,
  content: string,
  mode: number,
  hooks?: {
    before: GlobalLauncherMutationPoint;
    after: GlobalLauncherMutationPoint;
    environment: GlobalLauncherEnvironment;
  },
): Promise<void> {
  const temporary = adjacentTemporary(destination);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (hooks !== undefined) await callMutationHook(hooks.environment, hooks.before);
    await rename(temporary, destination);
    if (hooks !== undefined) await callMutationHook(hooks.environment, hooks.after);
    await syncDirectory(path.dirname(destination));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function callMutationHook(
  environment: GlobalLauncherEnvironment,
  point: GlobalLauncherMutationPoint,
): Promise<void> {
  await (environment as HookedEnvironment)[GLOBAL_LAUNCHER_TEST_HOOK]?.(point);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function launcherContent(
  activation: Omit<GlobalLauncherActivation, "launcherSha256">,
  platform: NodeJS.Platform,
  markerPath: string,
): string {
  const identity: LauncherIdentity = {
    protocol: activation.protocol,
    launcherPath: activation.launcherPath,
    packageRoot: activation.packageRoot,
    launcherTarget: activation.launcherTarget,
    targetSha256: activation.targetSha256,
    markerPath,
    argumentOffset: platform === "win32" ? 1 : 2,
  };
  const runtime = selfCleaningLauncherRuntime(identity);
  if (platform === "win32") {
    const encodedRuntime = Buffer.from(runtime, "utf8").toString("base64url");
    return `@node -e "eval(Buffer.from('${encodedRuntime}','base64url').toString('utf8'))" -- %*\r\n`;
  }
  return `#!/usr/bin/env node\n${runtime}`;
}

function selfCleaningLauncherRuntime(identity: LauncherIdentity): string {
  const encodedIdentity = Buffer.from(JSON.stringify(identity), "utf8").toString("base64url");
  return `const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const identity = JSON.parse(Buffer.from("${encodedIdentity}", "base64url").toString("utf8"));
const activationFields = ["protocol", "launcherPath", "packageRoot", "launcherTarget", "targetSha256"];

function openRegular(source) {
  const handle = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(handle);
    if (!opened.isFile()) throw new Error("not a regular file");
    return { bytes: fs.readFileSync(handle), handle, opened };
  } catch (error) {
    fs.closeSync(handle);
    throw error;
  }
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sameActivation(marker) {
  return activationFields.every((field) => marker[field] === identity[field]);
}

function restoreRegularNoReplace(source, destination) {
  try {
    fs.linkSync(source, destination);
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
  }
}

function displaceAuthenticatedRegular(source, expectedSha256) {
  const displaced = path.join(
    path.dirname(source),
    "." + path.basename(source) + "." + crypto.randomUUID() + ".stale",
  );
  fs.renameSync(source, displaced);
  let matches = false;
  let displacedFile;
  try {
    displacedFile = openRegular(displaced);
    matches = sha256(displacedFile.bytes) === expectedSha256;
  } catch {
  } finally {
    if (displacedFile) fs.closeSync(displacedFile.handle);
  }
  if (!matches) {
    restoreRegularNoReplace(displaced, source);
    throw new Error("refusing to remove a launcher path that changed during cleanup");
  }
  fs.chmodSync(displaced, 0o600);
  return displaced;
}

function authenticateTarget() {
  let target;
  try {
    target = openRegular(identity.launcherTarget);
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
  try {
    const physicalRoot = fs.realpathSync(identity.packageRoot);
    const physicalTarget = fs.realpathSync(identity.launcherTarget);
    if (path.dirname(physicalTarget) !== path.join(physicalRoot, "bin")) {
      throw new Error("the installed Core launcher escapes its package");
    }
    const current = fs.statSync(physicalTarget);
    if (current.dev !== target.opened.dev || current.ino !== target.opened.ino) {
      throw new Error("the installed Core launcher changed during authentication");
    }
    if (sha256(target.bytes) !== identity.targetSha256) {
      throw new Error("the installed Core launcher does not match its authenticated generation");
    }
    return true;
  } finally {
    fs.closeSync(target.handle);
  }
}

function main() {
  const launcher = openRegular(identity.launcherPath);
  let marker;
  try {
    marker = openRegular(identity.markerPath);
    const parsed = JSON.parse(marker.bytes.toString("utf8"));
    if (
      !sameActivation(parsed) ||
      typeof parsed.launcherSha256 !== "string" ||
      parsed.launcherSha256 !== sha256(launcher.bytes)
    ) {
      throw new Error("the global launcher ownership marker does not authenticate this executable");
    }

    if (!authenticateTarget()) {
      fs.closeSync(launcher.handle);
      launcher.handle = undefined;
      fs.closeSync(marker.handle);
      marker.handle = undefined;
      displaceAuthenticatedRegular(identity.launcherPath, parsed.launcherSha256);
      displaceAuthenticatedRegular(identity.markerPath, sha256(marker.bytes));
      process.stderr.write(
        "koni: Core is no longer installed; removed its stale launcher. Reinstall with \`pi install npm:@koni/core\`.\\n",
      );
      process.exitCode = 127;
      return;
    }

    const result = childProcess.spawnSync(
      process.execPath,
      [identity.launcherTarget, ...process.argv.slice(identity.argumentOffset)],
      { env: process.env, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.signal) {
      process.kill(process.pid, result.signal);
      return;
    }
    process.exitCode = result.status === null ? 1 : result.status;
  } finally {
    if (launcher.handle !== undefined) fs.closeSync(launcher.handle);
    if (marker && marker.handle !== undefined) fs.closeSync(marker.handle);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write("koni: " + (error instanceof Error ? error.message : String(error)) + "\\n");
  process.exitCode = 1;
}
`;
}

function adjacentTemporary(destination: string): string {
  return path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
}

function isAdjacentTemporaryFor(destination: string, candidate: string): boolean {
  return (
    path.isAbsolute(candidate) &&
    path.dirname(candidate) === path.dirname(destination) &&
    new RegExp(`^\\.${escapeRegExp(path.basename(destination))}\\.[0-9a-f-]{36}\\.tmp$`, "u").test(
      path.basename(candidate),
    )
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function pathExistsNoFollow(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

function requireRealpath(candidate: string): string {
  return realpathSync(candidate);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
