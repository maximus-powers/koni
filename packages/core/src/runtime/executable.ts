import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { Sha256Digest } from "../shared/canonical.js";

const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;

export interface RuntimeExecutableIdentity {
  role: "node" | "git" | "sandbox";
  path: string;
  sha256: Sha256Digest;
  size: number;
  device: string;
  inode: string;
  mode: number;
  uid: number;
  gid: number;
  modifiedNs: string;
  changedNs: string;
}

export class RuntimeExecutableError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "RuntimeExecutableError";
    this.code = code;
  }
}

export async function resolveRuntimeExecutable(
  role: RuntimeExecutableIdentity["role"],
  command: string,
  pathValue: string | undefined,
  options: { requireRootOwned?: boolean } = {},
): Promise<RuntimeExecutableIdentity> {
  const candidates =
    command.includes(path.sep) || path.isAbsolute(command)
      ? [path.resolve(command)]
      : (pathValue ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((entry) => path.resolve(entry, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await captureRuntimeExecutable(role, candidate, options);
    } catch (error) {
      if (error instanceof RuntimeExecutableError && error.code !== "executable_unavailable") {
        throw error;
      }
    }
  }
  throw new RuntimeExecutableError(
    "executable_unavailable",
    `cannot resolve ${role} executable ${command}`,
  );
}

export async function captureRuntimeExecutable(
  role: RuntimeExecutableIdentity["role"],
  candidate: string,
  options: { requireRootOwned?: boolean } = {},
): Promise<RuntimeExecutableIdentity> {
  const canonical = await realpath(candidate).catch(() => {
    throw new RuntimeExecutableError(
      "executable_unavailable",
      `${role} executable is unavailable: ${candidate}`,
    );
  });
  const identity = await readExecutableIdentity(role, canonical);
  if (options.requireRootOwned === true && process.platform !== "win32" && identity.uid !== 0) {
    throw new RuntimeExecutableError(
      "executable_owner",
      `${role} executable must be owned by root: ${canonical}`,
    );
  }
  if (options.requireRootOwned === true && (identity.mode & 0o022) !== 0) {
    throw new RuntimeExecutableError(
      "executable_mode",
      `${role} executable must not be group/world writable: ${canonical}`,
    );
  }
  return identity;
}

export async function assertRuntimeExecutableCurrent(
  expected: RuntimeExecutableIdentity,
): Promise<void> {
  const current = await readExecutableIdentity(expected.role, expected.path).catch(() => undefined);
  if (current === undefined || !sameExecutable(current, expected)) {
    throw new RuntimeExecutableError(
      "executable_changed",
      `${expected.role} executable changed while the Koni authority was running: ${expected.path}`,
    );
  }
}

export function sameRuntimeExecutableIdentity(
  left: RuntimeExecutableIdentity,
  right: RuntimeExecutableIdentity,
): boolean {
  return sameExecutable(left, right);
}

export function isRuntimeExecutableIdentity(value: unknown): value is RuntimeExecutableIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Partial<RuntimeExecutableIdentity>;
  return (
    (entry.role === "node" || entry.role === "git" || entry.role === "sandbox") &&
    typeof entry.path === "string" &&
    path.isAbsolute(entry.path) &&
    typeof entry.sha256 === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(entry.sha256) &&
    typeof entry.size === "number" &&
    Number.isSafeInteger(entry.size) &&
    entry.size >= 0 &&
    typeof entry.device === "string" &&
    typeof entry.inode === "string" &&
    typeof entry.mode === "number" &&
    Number.isSafeInteger(entry.mode) &&
    typeof entry.uid === "number" &&
    Number.isSafeInteger(entry.uid) &&
    typeof entry.gid === "number" &&
    Number.isSafeInteger(entry.gid) &&
    typeof entry.modifiedNs === "string" &&
    typeof entry.changedNs === "string"
  );
}

async function readExecutableIdentity(
  role: RuntimeExecutableIdentity["role"],
  canonical: string,
): Promise<RuntimeExecutableIdentity> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(canonical, constants.O_RDONLY | noFollow).catch(() => {
    throw new RuntimeExecutableError(
      "executable_unavailable",
      `${role} executable cannot be opened: ${canonical}`,
    );
  });
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size > BigInt(MAX_EXECUTABLE_BYTES) ||
      (before.mode & 0o111n) === 0n
    ) {
      throw new RuntimeExecutableError(
        "executable_type",
        `${role} executable is not a safe bounded executable file`,
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const pathMetadata = await lstat(canonical, { bigint: true });
    if (
      !sameBigIntStat(before, after) ||
      !sameBigIntStat(after, pathMetadata) ||
      !pathMetadata.isFile() ||
      BigInt(position) !== after.size
    ) {
      throw new RuntimeExecutableError(
        "executable_race",
        `${role} executable changed while it was authenticated`,
      );
    }
    return {
      role,
      path: canonical,
      sha256: `sha256:${hash.digest("hex")}`,
      size: Number(after.size),
      device: String(after.dev),
      inode: String(after.ino),
      mode: Number(after.mode),
      uid: Number(after.uid),
      gid: Number(after.gid),
      modifiedNs: String(after.mtimeNs),
      changedNs: String(after.ctimeNs),
    };
  } finally {
    await handle.close();
  }
}

function sameBigIntStat(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameExecutable(
  left: RuntimeExecutableIdentity,
  right: RuntimeExecutableIdentity,
): boolean {
  return (
    left.role === right.role &&
    left.path === right.path &&
    left.sha256 === right.sha256 &&
    left.size === right.size &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.modifiedNs === right.modifiedNs &&
    left.changedNs === right.changedNs
  );
}
