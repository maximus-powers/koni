import { createHash, randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitClient, type GitRepositoryIdentity } from "../git/client.js";

export const AUTHORITY_LAYOUT_VERSION = 1 as const;

export interface AuthorityEndpoint {
  identity: GitRepositoryIdentity;
  stateRoot: string;
  endpoint: string;
  leasePath: string;
}

interface AuthorityLeaseRecord {
  protocol: "koni.authority-lease.v1";
  pid: number;
  nonce: string;
  endpoint: string;
  commonDirectory: string;
  startedAt: string;
}

interface AuthorityStartupLockRecord {
  protocol: "koni.authority-startup-lock.v1";
  pid: number;
  nonce: string;
  createdAt: string;
}

export class AuthorityLeaseError extends Error {
  public readonly code: "authority_running" | "lease_corrupt" | "lease_lost";

  public constructor(code: AuthorityLeaseError["code"], message: string) {
    super(message);
    this.name = "AuthorityLeaseError";
    this.code = code;
  }
}

export async function discoverAuthorityEndpoint(projectRoot: string): Promise<AuthorityEndpoint> {
  const identity = await GitClient.discover(projectRoot);
  const stateRoot = path.join(identity.commonDirectory, "koni");
  const digest = createHash("sha256").update(identity.commonDirectory).digest("hex").slice(0, 32);
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\koni-${digest}`
    : path.join(os.tmpdir(), `koni-${typeof process.getuid === "function" ? process.getuid() : "user"}`, `${digest}.sock`);
  return {
    identity,
    stateRoot,
    endpoint,
    leasePath: path.join(stateRoot, "authority", "lease.json"),
  };
}

export class AuthorityLease {
  readonly #record: AuthorityLeaseRecord;
  readonly #leasePath: string;
  #startupLock: AuthorityStartupLock | undefined;
  #released = false;

  private constructor(
    leasePath: string,
    record: AuthorityLeaseRecord,
    startupLock: AuthorityStartupLock,
  ) {
    this.#leasePath = leasePath;
    this.#record = record;
    this.#startupLock = startupLock;
  }

  public get nonce(): string {
    return this.#record.nonce;
  }

  public static async acquire(target: AuthorityEndpoint): Promise<AuthorityLease> {
    await mkdir(path.dirname(target.leasePath), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await mkdir(path.dirname(target.endpoint), { recursive: true, mode: 0o700 });
      await chmod(path.dirname(target.endpoint), 0o700);
    }
    const startupLock = await AuthorityStartupLock.acquire(target.leasePath);
    const record: AuthorityLeaseRecord = {
      protocol: "koni.authority-lease.v1",
      pid: process.pid,
      nonce: randomBytes(24).toString("base64url"),
      endpoint: target.endpoint,
      commonDirectory: target.identity.commonDirectory,
      startedAt: new Date().toISOString(),
    };
    try {
      let staleLease: AuthorityLeaseRecord | undefined;
      try {
        staleLease = await readLease(target.leasePath);
      } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
      }
      if (staleLease !== undefined) {
        if (
          staleLease.endpoint !== target.endpoint ||
          staleLease.commonDirectory !== target.identity.commonDirectory
        ) {
          throw new AuthorityLeaseError("lease_corrupt", "Koni authority lease targets another repository endpoint");
        }
        if (processExists(staleLease.pid)) {
          throw new AuthorityLeaseError(
            "authority_running",
            `Koni authority process ${staleLease.pid} already owns this Git repository`,
          );
        }
        // The startup lock serializes this compare-and-remove with every other Koni starter.
        // Re-read the nonce so an outside replacement cannot be silently discarded.
        const current = await readLease(target.leasePath);
        if (current.pid !== staleLease.pid || current.nonce !== staleLease.nonce) {
          throw new AuthorityLeaseError("lease_lost", "stale authority lease changed during reclamation");
        }
        await rm(target.leasePath, { force: true });
      }
      if (process.platform !== "win32") await rm(target.endpoint, { force: true });

      const candidate = `${target.leasePath}.candidate-${process.pid}-${record.nonce}`;
      const handle = await open(candidate, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      let published = false;
      try {
        // Hard-link publication is atomic and refuses replacement. A crash can leave only an
        // ignored candidate or one complete lease record, never a truncated authoritative lease.
        await link(candidate, target.leasePath);
        published = true;
        await syncDirectory(path.dirname(target.leasePath));
      } catch (error) {
        if (published) await rm(target.leasePath, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        await rm(candidate, { force: true });
      }
      return new AuthorityLease(target.leasePath, record, startupLock);
    } catch (error) {
      await startupLock.release().catch(() => undefined);
      throw error;
    }
  }

  /** Release the serialized startup transaction only after the listener is live and permissioned. */
  public async completeStartup(): Promise<void> {
    const startupLock = this.#startupLock;
    if (startupLock === undefined) return;
    await startupLock.release();
    this.#startupLock = undefined;
  }

  public async release(): Promise<void> {
    if (this.#released) {
      const startupLock = this.#startupLock;
      if (startupLock !== undefined) {
        await startupLock.release();
        this.#startupLock = undefined;
      }
      return;
    }
    try {
      const current = await readLease(this.#leasePath);
      if (current.nonce !== this.#record.nonce || current.pid !== process.pid) {
        throw new AuthorityLeaseError("lease_lost", "authority lease ownership changed before release");
      }
      await rm(this.#leasePath, { force: true });
      this.#released = true;
    } finally {
      const startupLock = this.#startupLock;
      if (startupLock !== undefined) {
        await startupLock.release();
        this.#startupLock = undefined;
      }
    }
  }
}

/**
 * Atomic same-filesystem startup mutex. A complete candidate directory is renamed into place, so
 * another process never observes a half-written owner. Dead owners are moved to a unique
 * quarantine with one atomic rename; only that winner may remove the stale directory.
 */
class AuthorityStartupLock {
  readonly #lockPath: string;
  readonly #record: AuthorityStartupLockRecord;
  #released = false;
  #retiredPath: string | undefined;

  private constructor(lockPath: string, record: AuthorityStartupLockRecord) {
    this.#lockPath = lockPath;
    this.#record = record;
  }

  public static async acquire(leasePath: string): Promise<AuthorityStartupLock> {
    const lockPath = `${leasePath}.startup-lock`;
    const parent = path.dirname(lockPath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const record: AuthorityStartupLockRecord = {
        protocol: "koni.authority-startup-lock.v1",
        pid: process.pid,
        nonce: randomBytes(24).toString("base64url"),
        createdAt: new Date().toISOString(),
      };
      const candidate = `${lockPath}.candidate-${process.pid}-${record.nonce}`;
      await mkdir(candidate, { mode: 0o700 });
      try {
        const owner = await open(path.join(candidate, "owner.json"), "wx", 0o600);
        try {
          await owner.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await owner.sync();
        } finally {
          await owner.close();
        }
        try {
          await rename(candidate, lockPath);
          await syncDirectory(parent);
          return new AuthorityStartupLock(lockPath, record);
        } catch (error) {
          if (!isExistingDestination(error)) throw error;
        }
      } finally {
        await rm(candidate, { recursive: true, force: true });
      }

      let existing: AuthorityStartupLockRecord;
      try {
        existing = await readStartupLock(lockPath);
      } catch (error) {
        if (isCode(error, "ENOENT")) continue;
        throw error;
      }
      if (processExists(existing.pid)) {
        throw new AuthorityLeaseError(
          "authority_running",
          `Koni authority startup process ${existing.pid} already owns endpoint admission`,
        );
      }
      const quarantine = `${lockPath}.stale-${process.pid}-${randomBytes(12).toString("base64url")}`;
      try {
        await rename(lockPath, quarantine);
        await syncDirectory(parent);
        await rm(quarantine, { recursive: true, force: true });
        await syncDirectory(parent);
      } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
      }
    }
    throw new AuthorityLeaseError("authority_running", "could not serialize Koni authority startup");
  }

  public async release(): Promise<void> {
    if (this.#released) return;
    if (this.#retiredPath === undefined) {
      const current = await readStartupLock(this.#lockPath);
      if (current.pid !== this.#record.pid || current.nonce !== this.#record.nonce) {
        throw new AuthorityLeaseError("lease_lost", "authority startup lock ownership changed before release");
      }
      const quarantine = `${this.#lockPath}.released-${process.pid}-${randomBytes(12).toString("base64url")}`;
      await rename(this.#lockPath, quarantine);
      this.#retiredPath = quarantine;
    }
    await syncDirectory(path.dirname(this.#lockPath));
    await rm(this.#retiredPath, { recursive: true, force: true });
    await syncDirectory(path.dirname(this.#lockPath));
    this.#released = true;
  }
}

async function readStartupLock(lockPath: string): Promise<AuthorityStartupLockRecord> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
  } catch (error) {
    if (isCode(error, "ENOENT")) throw error;
    throw new AuthorityLeaseError("lease_corrupt", "Koni authority startup lock is unreadable");
  }
  if (
    !isRecord(value) ||
    value.protocol !== "koni.authority-startup-lock.v1" ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1 ||
    typeof value.nonce !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    throw new AuthorityLeaseError("lease_corrupt", "Koni authority startup lock has an invalid shape");
  }
  return value as unknown as AuthorityStartupLockRecord;
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readLease(leasePath: string): Promise<AuthorityLeaseRecord> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(await realpath(leasePath), "utf8"));
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      throw error;
    }
    throw new AuthorityLeaseError("lease_corrupt", "Koni authority lease is unreadable");
  }
  if (
    !isRecord(value) ||
    value.protocol !== "koni.authority-lease.v1" ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1 ||
    typeof value.nonce !== "string" ||
    typeof value.endpoint !== "string" ||
    typeof value.commonDirectory !== "string" ||
    typeof value.startedAt !== "string"
  ) {
    throw new AuthorityLeaseError("lease_corrupt", "Koni authority lease has an invalid shape");
  }
  return value as unknown as AuthorityLeaseRecord;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isCode(error, "ESRCH");
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function isExistingDestination(error: unknown): boolean {
  return ["EEXIST", "ENOTEMPTY", "EPERM"].some((code) => isCode(error, code));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
