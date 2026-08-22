import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  stat,
  symlink,
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
}

interface ActivationJournal {
  protocol: "koni.global-launcher-journal.v1";
  operation: "activate";
  previous: GlobalLauncherActivation | null;
  next: GlobalLauncherActivation;
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
  const activation = await activationFor(environment, launcherPath);
  const markerDirectory = path.join(path.resolve(environment.agentDir), "koni");
  await ensurePrivateMarkerDirectory(environment.agentDir, markerDirectory);
  const markerPath = path.join(markerDirectory, "global-launcher.json");
  const journalPath = path.join(markerDirectory, "global-launcher.pending.json");
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
  };
  await publishFileAtomically(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
  await publishLauncher(activation, environment);
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
  const current = await activationFor(environment, launcherPath);
  if (!sameActivation(marker, current) || !(await targetMatchesDigest(marker))) return "not_owner";
  if (launcherExists && !(await launcherMatches(marker, environment.platform))) return "not_owner";
  if (launcherExists) await unlink(launcherPath);
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
  if (!(await targetMatchesDigest(journal.next))) {
    throw new Error("refusing global launcher recovery because its intended target changed");
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
  if (!launcherIsNext && !launcherIsPrevious && (launcherExists || journal.previous !== null)) {
    throw new Error(`refusing to overwrite an unrelated koni launcher at ${launcherPath}`);
  }
  if (!launcherIsNext) await publishLauncher(journal.next, environment, false);
  if (marker === undefined || !sameActivation(marker, journal.next)) {
    await publishFileAtomically(markerPath, `${JSON.stringify(journal.next, null, 2)}\n`, 0o600);
  }
  await unlink(journalPath);
  await syncDirectory(path.dirname(journalPath));
}

async function activationFor(
  environment: GlobalLauncherEnvironment,
  launcherPath: string,
): Promise<GlobalLauncherActivation> {
  const packageRoot = path.resolve(environment.packageRoot);
  const launcherTarget = path.join(packageRoot, "bin", "koni.js");
  await assertRegularTargetWithinPackage(launcherTarget, packageRoot);
  return {
    protocol: ACTIVATION_PROTOCOL,
    launcherPath,
    packageRoot,
    launcherTarget,
    targetSha256: createHash("sha256")
      .update(await readFile(launcherTarget))
      .digest("hex"),
  };
}

async function findSolePiExecutable(environment: GlobalLauncherEnvironment): Promise<string> {
  const names = environment.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
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
      } catch {
        // A PATH entry is a candidate only when it names a runnable regular file.
      }
    }
  }
  if (matches.size === 0) throw new Error("could not locate Pi on PATH");
  if (matches.size !== 1) throw new Error("refusing ambiguous Pi executables on PATH");
  return [...matches.values()][0]!;
}

async function assertRegularTargetWithinPackage(
  target: string,
  packageRoot: string,
): Promise<void> {
  const metadata = await lstat(target);
  if (!metadata.isFile())
    throw new Error(`the Koni launcher target is not a regular file: ${target}`);
  const physicalRoot = await realpath(packageRoot);
  const physicalTarget = await realpath(target);
  if (path.dirname(physicalTarget) !== path.join(physicalRoot, "bin")) {
    throw new Error(`the Koni launcher target escapes its package: ${target}`);
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
    (record.previous !== null && !isActivationRecord(record.previous))
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
    /^[a-f0-9]{64}$/u.test(record.targetSha256)
  );
}

async function launcherMatches(
  activation: GlobalLauncherActivation,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    const metadata = await lstat(activation.launcherPath);
    if (platform === "win32") {
      return (
        metadata.isFile() &&
        !metadata.isSymbolicLink() &&
        (await readFile(activation.launcherPath, "utf8")) === windowsShim(activation.launcherTarget)
      );
    }
    if (!metadata.isSymbolicLink()) return false;
    const target = await readlink(activation.launcherPath);
    return (
      path.resolve(path.dirname(activation.launcherPath), target) === activation.launcherTarget
    );
  } catch {
    return false;
  }
}

async function targetMatchesDigest(activation: GlobalLauncherActivation): Promise<boolean> {
  try {
    const metadata = await lstat(activation.launcherTarget);
    if (!metadata.isFile()) return false;
    const digest = createHash("sha256")
      .update(await readFile(activation.launcherTarget))
      .digest("hex");
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
    left.targetSha256 === right.targetSha256
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

async function publishLauncher(
  activation: GlobalLauncherActivation,
  environment: GlobalLauncherEnvironment,
  invokeHooks = true,
): Promise<void> {
  const temporary = adjacentTemporary(activation.launcherPath);
  try {
    if (environment.platform === "win32") {
      await writeFile(temporary, windowsShim(activation.launcherTarget), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o755,
      });
    } else {
      await symlink(activation.launcherTarget, temporary, "file");
    }
    if (invokeHooks) await callMutationHook(environment, "before_launcher_rename");
    await rename(temporary, activation.launcherPath);
    if (invokeHooks) await callMutationHook(environment, "after_launcher_rename");
    await syncDirectory(path.dirname(activation.launcherPath));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
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

function windowsShim(target: string): string {
  return `@node "${target.replaceAll('"', '""')}" %*\r\n`;
}

function adjacentTemporary(destination: string): string {
  return path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
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
