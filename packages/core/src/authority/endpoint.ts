import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
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
  #released = false;

  private constructor(leasePath: string, record: AuthorityLeaseRecord) {
    this.#leasePath = leasePath;
    this.#record = record;
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
    const record: AuthorityLeaseRecord = {
      protocol: "koni.authority-lease.v1",
      pid: process.pid,
      nonce: randomBytes(24).toString("base64url"),
      endpoint: target.endpoint,
      commonDirectory: target.identity.commonDirectory,
      startedAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(target.leasePath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new AuthorityLease(target.leasePath, record);
      } catch (error) {
        if (!isCode(error, "EEXIST")) {
          throw error;
        }
        const existing = await readLease(target.leasePath);
        if (processExists(existing.pid)) {
          throw new AuthorityLeaseError(
            "authority_running",
            `Koni authority process ${existing.pid} already owns this Git repository`,
          );
        }
        await rm(target.leasePath, { force: true });
        if (process.platform !== "win32") {
          await rm(target.endpoint, { force: true });
        }
      }
    }
    throw new AuthorityLeaseError("authority_running", "could not acquire the Koni authority lease");
  }

  public async release(): Promise<void> {
    if (this.#released) {
      return;
    }
    const current = await readLease(this.#leasePath);
    if (current.nonce !== this.#record.nonce || current.pid !== process.pid) {
      throw new AuthorityLeaseError("lease_lost", "authority lease ownership changed before release");
    }
    await rm(this.#leasePath, { force: true });
    this.#released = true;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
