import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { preparePiRuntime } from "../packages/core/bin/koni.js";

const PROTOCOL = "koni.dev-activation.v1";
const MAX_SETTINGS_BYTES = 8 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const KONI_PACKAGES = new Set([
  "@koni/core",
  "@koni/coding-profile",
  "@koni/research-profile",
]);

const [command, journalInput, launcherInput, targetInput, ...rootInputs] = process.argv.slice(2);
if (!journalInput || !launcherInput || !["activate", "rollback", "commit"].includes(command)) {
  throw new Error("usage: register-dev-packages.mjs activate JOURNAL LAUNCHER TARGET ROOT... | rollback|commit JOURNAL LAUNCHER");
}
const journalPath = path.resolve(journalInput);
const launcherPath = path.resolve(launcherInput);
const piPackageRoot = await preparePiRuntime();
const piRequire = createRequire(path.join(piPackageRoot, "package.json"));
const lockfile = piRequire("proper-lockfile");
const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent"));
const settingsPath = path.join(agentDir, "settings.json");

async function activate({ packageRoots, launcherTarget }) {
  if (existsSync(journalPath)) throw new Error(`unfinished Koni activation journal exists: ${journalPath}`);
  cleanupAtomicTempsSync(journalPath);
  // A crash after copying an old regular launcher but before publishing the journal leaves no
  // activation to recover; remove that fixed-name orphan before taking a new snapshot.
  await fs.rm(`${journalPath}.launcher-backup`, { force: true });
  const storage = createAtomicSettingsStorage();
  const launcher = await snapshotLauncher(launcherPath, journalPath);
  await storage.transaction(async () => {
    if (existsSync(journalPath)) throw new Error(`unfinished Koni activation journal exists: ${journalPath}`);
    const previousSettings = storage.snapshot();
    const previous = parseSettingsSnapshot(previousSettings);
    const previousPackages = previous.packages ?? [];
    const previousKoni = previousPackages.filter((entry) => isKoniSource(entry, agentDir));
    const retained = previousPackages.filter((entry) => !isKoniSource(entry, agentDir));
    const desiredPackages = [...retained, ...packageRoots];
    const desired = SettingsManager.migrateSettings(structuredClone(previous));
    desired.packages = desiredPackages;
    const desiredBytes = Buffer.from(JSON.stringify(desired, null, 2), "utf8");
    const journal = {
      protocol: PROTOCOL,
      settings_path: settingsPath,
      previous_settings: fileIdentity(previousSettings),
      activated_settings_sha256: sha256(desiredBytes),
      activated_koni_packages: packageRoots,
      launcher_path: launcherPath,
      launcher_target: launcherTarget,
      launcher,
      previous_koni_packages: previousKoni,
      new_package_roots: packageRoots,
    };
    publishExclusiveFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600, "journal");
    maybePauseWhileLocked();
    const settings = createGlobalSettings(storage);
    settings.setPackages(desiredPackages);
    await settings.flush();
    assertNoSettingsErrors(settings, "write");
    const activated = storage.snapshot();
    if (activated.kind !== "file" || activated.sha256 !== journal.activated_settings_sha256) {
      throw new Error("Pi settings activation did not publish the journal-bound bytes");
    }
  });
}

async function rollback(journal) {
  const storage = createAtomicSettingsStorage();
  await storage.transaction(async () => {
    const currentSnapshot = storage.snapshot();
    const currentIdentity = fileIdentity(currentSnapshot);
    if (!sameFileIdentity(currentIdentity, journal.previous_settings)) {
      if (currentSnapshot.kind === "absent") {
        throw new Error("Pi settings disappeared after Koni activation; refusing an ambiguous rollback");
      }
      const current = parseSettingsSnapshot(currentSnapshot);
      const currentPackages = current.packages ?? [];
      const currentKoni = currentPackages.filter((entry) => isKoniSource(entry, agentDir));
      if (!samePackageEntries(currentKoni, journal.previous_koni_packages)) {
        if (!samePackageEntries(currentKoni, journal.activated_koni_packages)) {
          throw new Error(
            "Pi Koni package sources changed after activation; remove the newer source explicitly before retrying rollback",
          );
        }
        if (currentSnapshot.sha256 === journal.activated_settings_sha256 && journal.previous_settings.kind === "absent") {
          storage.remove();
        } else {
          const settings = createGlobalSettings(storage);
          settings.setPackages([
            ...currentPackages.filter((entry) => !isKoniSource(entry, agentDir)),
            ...journal.previous_koni_packages,
          ]);
          await settings.flush();
          assertNoSettingsErrors(settings, "rollback");
        }
      }
    }
    maybeCrashAfterSettingsRollback();
    await restoreLauncher(journal.launcher, launcherPath, journalPath);
    await cleanupJournal(journalPath);
  });
}

function sameFileIdentity(left, right) {
  if (left.kind !== right.kind) return false;
  return left.kind === "absent" || left.sha256 === right.sha256;
}

function samePackageEntries(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function commit(journal) {
  const storage = createAtomicSettingsStorage();
  await storage.transaction(async () => {
    const settings = createGlobalSettings(storage);
    const current = settings.getGlobalSettings().packages ?? [];
    const currentKoni = current.filter((entry) => isKoniSource(entry, agentDir));
    if (!samePackageEntries(currentKoni, journal.activated_koni_packages)) {
      throw new Error("Pi Koni package sources changed before activation commit");
    }
    const metadata = lstatSync(launcherPath);
    if (!metadata.isSymbolicLink() || path.resolve(path.dirname(launcherPath), await fs.readlink(launcherPath)) !== journal.launcher_target) {
      throw new Error("Koni launcher does not point at the activated package root");
    }
    await cleanupJournal(journalPath);
  });
}

function createGlobalSettings(storage) {
  const settings = SettingsManager.fromStorage(storage, {
    projectTrusted: false,
  });
  assertNoSettingsErrors(settings, "load");
  return settings;
}

function createAtomicSettingsStorage() {
  return new AtomicGlobalSettingsStorage(settingsPath, lockfile);
}

class AtomicGlobalSettingsStorage {
  constructor(globalPath, activeLockfile) {
    this.globalPath = globalPath;
    this.lockfile = activeLockfile;
    this.inTransaction = false;
  }

  withLock(scope, update) {
    if (scope !== "global") throw new Error("Koni package registration must never access project Pi settings");
    if (this.inTransaction) return this.performLocked(update);
    const release = this.acquireSync();
    try {
      return this.performLocked(update);
    } finally {
      release();
    }
  }

  async transaction(update) {
    if (this.inTransaction) throw new Error("nested Pi settings transactions are not allowed");
    const release = await this.acquireAsync();
    this.inTransaction = true;
    try {
      return await update();
    } finally {
      this.inTransaction = false;
      release();
    }
  }

  acquireSync() {
    mkdirSync(path.dirname(this.globalPath), { recursive: true });
    let lastError;
    for (let attempt = 0; attempt <= 120; attempt += 1) {
      try {
        return this.lockfile.lockSync(this.globalPath, { realpath: false });
      } catch (error) {
        lastError = error;
        if (error?.code !== "ELOCKED" || attempt === 120) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
    throw lastError ?? new Error("failed to acquire Pi settings lock");
  }

  async acquireAsync() {
    mkdirSync(path.dirname(this.globalPath), { recursive: true });
    // Pi's default lease declares a killed owner stale after 10 seconds. Retry through that same
    // window so the next installer can perform journal recovery without deleting another owner's lock.
    return this.lockfile.lock(this.globalPath, {
      realpath: false,
      retries: { retries: 120, factor: 1, minTimeout: 100, maxTimeout: 100 },
    });
  }

  performLocked(update) {
    cleanupAtomicTempsSync(this.globalPath);
    const snapshot = snapshotFileSync(this.globalPath, MAX_SETTINGS_BYTES);
    const current = snapshot.kind === "file"
      ? Buffer.from(snapshot.bytes_base64, "base64").toString("utf8")
      : undefined;
    const next = update(current);
    if (next !== undefined) {
      atomicReplaceFileSync(
        this.globalPath,
        Buffer.from(next, "utf8"),
        snapshot.kind === "file" ? snapshot.mode : 0o600,
        "settings",
      );
    }
    return next;
  }

  snapshot() {
    let snapshot;
    this.withLock("global", (current) => {
      snapshot = current === undefined
        ? { kind: "absent" }
        : snapshotFileSync(this.globalPath, MAX_SETTINGS_BYTES);
      return undefined;
    });
    return snapshot;
  }

  remove() {
    this.withLock("global", () => {
      atomicRemoveFileSync(this.globalPath);
      return undefined;
    });
  }
}

async function snapshotLauncher(launcher, journal) {
  if (!existsSync(launcher) && !isSymlink(launcher)) return { kind: "absent" };
  const metadata = lstatSync(launcher);
  if (metadata.isSymbolicLink()) return { kind: "symlink", target: await fs.readlink(launcher) };
  if (!metadata.isFile()) throw new Error("existing Koni launcher is not a file or symlink");
  const backup = `${journal}.launcher-backup`;
  if (existsSync(backup)) throw new Error(`unfinished Koni launcher backup exists: ${backup}`);
  await fs.copyFile(launcher, backup, fs.constants.COPYFILE_EXCL);
  const backupHandle = await fs.open(backup, "r");
  try { await backupHandle.sync(); } finally { await backupHandle.close(); }
  fsyncDirectorySync(path.dirname(backup));
  const bytes = await fs.readFile(backup);
  return { kind: "file", backup, sha256: createHash("sha256").update(bytes).digest("hex"), mode: metadata.mode & 0o777 };
}

async function restoreLauncher(snapshot, launcher, journal) {
  const temporary = `${launcher}.rollback-${process.pid}`;
  await fs.rm(temporary, { force: true });
  if (snapshot.kind === "absent") {
    await fs.rm(launcher, { force: true });
    fsyncDirectorySync(path.dirname(launcher));
    return;
  }
  if (snapshot.kind === "symlink") {
    await fs.symlink(snapshot.target, temporary);
  } else if (snapshot.kind === "file") {
    const bytes = await fs.readFile(snapshot.backup);
    if (createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256) {
      throw new Error("Koni launcher rollback backup failed authentication");
    }
    await fs.copyFile(snapshot.backup, temporary);
    await fs.chmod(temporary, snapshot.mode);
    const temporaryHandle = await fs.open(temporary, "r");
    try { await temporaryHandle.sync(); } finally { await temporaryHandle.close(); }
  } else throw new Error("unknown launcher rollback kind");
  await fs.rename(temporary, launcher);
  fsyncDirectorySync(path.dirname(launcher));
}

async function cleanupJournal(journal) {
  // Journal-first deletion is phase-safe: a crash can leave only an unreferenced backup, which the
  // next activation removes. Deleting the backup first could make a still-published journal
  // impossible to roll back.
  await fs.rm(journal, { force: true });
  fsyncDirectorySync(path.dirname(journal));
  await fs.rm(`${journal}.launcher-backup`, { force: true });
  fsyncDirectorySync(path.dirname(journal));
}

function snapshotFileSync(target, maximumBytes) {
  if (!existsSync(target) && !isSymlink(target)) return { kind: "absent" };
  const metadata = lstatSync(target);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    throw new Error(`${target} is not a bounded real file`);
  }
  const bytes = readFileSync(target);
  return {
    kind: "file",
    bytes_base64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mode: metadata.mode & 0o777,
  };
}

function validateFileSnapshot(snapshot) {
  if (snapshot?.kind === "absent") return;
  if (!(snapshot?.kind === "file" &&
    typeof snapshot.bytes_base64 === "string" &&
    /^[A-Za-z0-9+/]*={0,2}$/u.test(snapshot.bytes_base64) &&
    /^[a-f0-9]{64}$/u.test(snapshot.sha256 ?? "") &&
    Number.isInteger(snapshot.mode) && snapshot.mode >= 0 && snapshot.mode <= 0o777)) {
    throw new Error("Koni activation journal has an invalid settings snapshot");
  }
  const bytes = Buffer.from(snapshot.bytes_base64, "base64");
  if (bytes.length > MAX_SETTINGS_BYTES ||
    bytes.toString("base64") !== snapshot.bytes_base64 ||
    createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256) {
    throw new Error("Koni activation journal settings snapshot failed authentication");
  }
}

function fileIdentity(snapshot) {
  validateFileSnapshot(snapshot);
  return snapshot.kind === "absent"
    ? { kind: "absent" }
    : { kind: "file", sha256: snapshot.sha256, mode: snapshot.mode };
}

function validateFileIdentity(identity) {
  if (identity?.kind === "absent") return;
  if (!(identity?.kind === "file" &&
    /^[a-f0-9]{64}$/u.test(identity.sha256 ?? "") &&
    Number.isInteger(identity.mode) && identity.mode >= 0 && identity.mode <= 0o777 &&
    !("bytes_base64" in identity))) {
    throw new Error("Koni activation journal has an invalid settings identity");
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseSettingsSnapshot(snapshot) {
  validateFileSnapshot(snapshot);
  if (snapshot.kind === "absent") return {};
  const value = JSON.parse(Buffer.from(snapshot.bytes_base64, "base64").toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    (value.packages !== undefined && !Array.isArray(value.packages))) {
    throw new Error("Pi global settings must be a JSON object with an optional packages array");
  }
  return value;
}

function publishExclusiveFileSync(target, contents, mode, crashLabel) {
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true });
  const temporary = atomicTemporaryPath(target);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    maybeCrashAfterFsync(crashLabel);
    // A hard-link publish gives the journal create-if-absent semantics without exposing partial
    // bytes. Both names are in the same directory/filesystem and the inode was fsynced first.
    linkSync(temporary, target);
    fsyncDirectorySync(directory);
    rmSync(temporary);
    fsyncDirectorySync(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function atomicReplaceFileSync(target, contents, mode, crashLabel) {
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true });
  const temporary = atomicTemporaryPath(target);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    maybeCrashAfterFsync(crashLabel);
    renameSync(temporary, target);
    fsyncDirectorySync(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function atomicRemoveFileSync(target) {
  if (!existsSync(target) && !isSymlink(target)) return;
  const metadata = lstatSync(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${target} is not a real file`);
  }
  rmSync(target);
  fsyncDirectorySync(path.dirname(target));
}

function atomicTemporaryPath(target) {
  return path.join(path.dirname(target), `.${path.basename(target)}.koni-tmp-${process.pid}-${randomUUID()}`);
}

function cleanupAtomicTempsSync(target) {
  const directory = path.dirname(target);
  if (!existsSync(directory)) return;
  const prefix = `.${path.basename(target)}.koni-tmp-`;
  for (const entry of readdirSync(directory)) {
    if (entry.startsWith(prefix)) rmSync(path.join(directory, entry), { force: true });
  }
}

function fsyncDirectorySync(directory) {
  const descriptor = openSync(directory, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function maybeCrashAfterFsync(label) {
  if (process.env.NODE_ENV === "test" && process.env.KONI_TEST_CRASH_AFTER_FSYNC === label) {
    process.kill(process.pid, "SIGKILL");
  }
}

function maybePauseWhileLocked() {
  if (process.env.NODE_ENV !== "test") return;
  const milliseconds = Number(process.env.KONI_TEST_PAUSE_AFTER_JOURNAL_MS ?? "0");
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 5000) {
    throw new Error("invalid KONI_TEST_PAUSE_AFTER_JOURNAL_MS");
  }
  if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function maybeCrashAfterSettingsRollback() {
  if (process.env.NODE_ENV === "test" && process.env.KONI_TEST_CRASH_AFTER_SETTINGS_ROLLBACK === "1") {
    process.kill(process.pid, "SIGKILL");
  }
}

function readJournal(journal, expectedLauncher) {
  const metadata = lstatSync(journal);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_JOURNAL_BYTES) {
    throw new Error("Koni activation journal is not a bounded real file");
  }
  const value = JSON.parse(readFileSync(journal, "utf8"));
  if (
    value?.protocol !== PROTOCOL ||
    value.settings_path !== settingsPath ||
    !validFileIdentity(value.previous_settings) ||
    !/^[a-f0-9]{64}$/u.test(value.activated_settings_sha256 ?? "") ||
    !Array.isArray(value.activated_koni_packages) ||
    !samePackageEntries(value.activated_koni_packages, value.new_package_roots) ||
    value.launcher_path !== expectedLauncher ||
    !Array.isArray(value.previous_koni_packages) ||
    !value.previous_koni_packages.every((entry) => isKoniSource(entry, agentDir)) ||
    !Array.isArray(value.new_package_roots) ||
    value.new_package_roots.length !== 3 ||
    typeof value.launcher_target !== "string" ||
    !path.isAbsolute(value.launcher_target) ||
    !validLauncherSnapshot(value.launcher, journal)
  ) throw new Error("Koni activation journal has an invalid identity");
  validateFileIdentity(value.previous_settings);
  validatePackageRoots(value.new_package_roots);
  const coreRoot = value.new_package_roots.find((root) => readManifest(root)?.name === "@koni/core");
  if (value.launcher_target !== path.join(coreRoot, "bin", "koni.js")) {
    throw new Error("Koni activation journal launcher target is outside the authenticated Core root");
  }
  return value;
}

function validFileIdentity(snapshot) {
  try {
    validateFileIdentity(snapshot);
    return true;
  } catch {
    return false;
  }
}

function validLauncherSnapshot(snapshot, journal) {
  if (snapshot?.kind === "absent") return true;
  if (snapshot?.kind === "symlink") return typeof snapshot.target === "string";
  if (!(snapshot?.kind === "file" &&
    snapshot.backup === `${journal}.launcher-backup` &&
    /^[a-f0-9]{64}$/u.test(snapshot.sha256 ?? "") &&
    Number.isInteger(snapshot.mode) && snapshot.mode >= 0 && snapshot.mode <= 0o777)) return false;
  try {
    const metadata = lstatSync(snapshot.backup);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
    return createHash("sha256").update(readFileSync(snapshot.backup)).digest("hex") === snapshot.sha256;
  } catch {
    return false;
  }
}

function validatePackageRoots(packageRoots) {
  const names = new Set();
  for (const packageRoot of packageRoots) {
    const metadata = lstatSync(packageRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${packageRoot} is not a real package directory`);
    const manifest = readManifest(packageRoot);
    if (!KONI_PACKAGES.has(manifest?.name)) throw new Error(`${packageRoot} is not one of Koni's public packages`);
    names.add(manifest.name);
  }
  if (names.size !== KONI_PACKAGES.size) throw new Error("the activation roots do not contain each Koni package exactly once");
}

function isKoniSource(entry, agentDir) {
  const source = typeof entry === "string" ? entry : entry?.source;
  if (typeof source !== "string") return false;
  if (/^npm:@koni\/(?:core|coding-profile|research-profile)(?:@|$)/u.test(source)) return true;
  if (source.startsWith("git:")) return false;
  const candidate = path.resolve(path.isAbsolute(source) ? source : path.join(agentDir, source));
  return KONI_PACKAGES.has(readManifest(candidate)?.name);
}

function readManifest(packageRoot) {
  const manifestPath = path.join(packageRoot, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  try { return JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return undefined; }
}

function assertNoSettingsErrors(settings, phase) {
  const errors = settings.drainErrors();
  if (errors.length === 0) return;
  throw new Error(`Pi settings ${phase} failed: ${errors.map(({ scope, error }) =>
    `${scope}: ${error instanceof Error ? error.message : String(error)}`).join("; ")}`);
}

function isSymlink(target) {
  try { return lstatSync(target).isSymbolicLink(); } catch { return false; }
}

if (command === "activate") {
  const packageRoots = rootInputs.map((entry) => path.resolve(entry));
  if (!targetInput || packageRoots.length !== 3) throw new Error("activate requires a target and three package roots");
  validatePackageRoots(packageRoots);
  await activate({ packageRoots, launcherTarget: path.resolve(targetInput) });
} else {
  // rollback/commit have no target; the positional parser places no meaningful value there.
  const journal = readJournal(journalPath, launcherPath);
  if (command === "rollback") await rollback(journal);
  else await commit(journal);
}
