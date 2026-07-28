import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

export type DurableFileReadErrorCode = "file_type" | "file_size" | "file_changed";
export type DurableFileReadErrorReason =
  "invalid_bound" | "initial_empty" | "initial_oversize" | "growth";

export class DurableFileReadError extends Error {
  public readonly code: DurableFileReadErrorCode;
  public readonly reason: DurableFileReadErrorReason | undefined;

  public constructor(
    code: DurableFileReadErrorCode,
    message: string,
    reason?: DurableFileReadErrorReason,
  ) {
    super(message);
    this.name = "DurableFileReadError";
    this.code = code;
    this.reason = reason;
  }
}

/** @internal Deterministic test seam; production callers must not supply hooks. */
export interface DurableFileReadTestHooks {
  read?: (
    handle: FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ bytesRead: number }>;
  afterOpenStat?: (handle: FileHandle, size: number) => Promise<void> | void;
  beforeIdentityCheck?: (handle: FileHandle, size: number) => Promise<void> | void;
}

export interface StableDurableFileOptions {
  maximum: number;
  minimum?: 0 | 1;
  label: string;
  /** @internal */
  testHooks?: DurableFileReadTestHooks;
}

export async function readStableDurableFile(
  file: string,
  options: StableDurableFileOptions,
): Promise<Buffer> {
  return withStableDurableFile(file, options, async (handle, size, read) => {
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const result = await read(handle, bytes, offset, size - offset, offset);
      if (result.bytesRead === 0) {
        throw new DurableFileReadError(
          "file_changed",
          `${options.label} changed while it was read`,
        );
      }
      offset += result.bytesRead;
    }
    return bytes;
  });
}

export async function hashStableDurableFile(
  file: string,
  options: StableDurableFileOptions,
): Promise<string> {
  return withStableDurableFile(file, options, async (handle, size, read) => {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(size, 1)));
    let offset = 0;
    while (offset < size) {
      const length = Math.min(buffer.byteLength, size - offset);
      const result = await read(handle, buffer, 0, length, offset);
      if (result.bytesRead === 0) {
        throw new DurableFileReadError(
          "file_changed",
          `${options.label} changed while it was hashed`,
        );
      }
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    return `sha256:${hash.digest("hex")}`;
  });
}

type StableRead = DurableFileReadTestHooks["read"] extends infer Read
  ? Exclude<Read, undefined>
  : never;

async function withStableDurableFile<Value>(
  file: string,
  options: StableDurableFileOptions,
  operation: (handle: FileHandle, size: number, read: StableRead) => Promise<Value>,
): Promise<Value> {
  const minimum = options.minimum ?? 1;
  if (
    !Number.isSafeInteger(options.maximum) ||
    options.maximum < minimum ||
    (minimum !== 0 && minimum !== 1)
  ) {
    throw new DurableFileReadError(
      "file_size",
      `${options.label} has an invalid durable byte bound`,
      "invalid_bound",
    );
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const nonblocking = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | noFollow | nonblocking);
  } catch (error) {
    if (isCode(error, "ELOOP") || isCode(error, "EMLINK")) {
      throw new DurableFileReadError("file_type", `${options.label} is not a safe regular file`);
    }
    throw error;
  }
  const read: StableRead =
    options.testHooks?.read ??
    ((target, buffer, offset, length, position) => target.read(buffer, offset, length, position));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new DurableFileReadError("file_type", `${options.label} is not a safe regular file`);
    }
    if (before.size < BigInt(minimum)) {
      throw new DurableFileReadError(
        "file_size",
        `${options.label} is below its durable byte bound`,
        "initial_empty",
      );
    }
    if (before.size > BigInt(options.maximum)) {
      throw new DurableFileReadError(
        "file_size",
        `${options.label} exceeds its durable byte bound`,
        "initial_oversize",
      );
    }
    const size = Number(before.size);
    await options.testHooks?.afterOpenStat?.(handle, size);
    const value = await operation(handle, size, read);
    const probe = Buffer.allocUnsafe(1);
    if ((await read(handle, probe, 0, 1, size)).bytesRead !== 0) {
      throw new DurableFileReadError(
        "file_size",
        `${options.label} grew while it was read`,
        "growth",
      );
    }
    await options.testHooks?.beforeIdentityCheck?.(handle, size);
    const after = await handle.stat({ bigint: true });
    let pathAfter;
    try {
      pathAfter = await lstat(file, { bigint: true });
    } catch {
      throw new DurableFileReadError("file_changed", `${options.label} changed while it was read`);
    }
    if (
      !after.isFile() ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.dev !== pathAfter.dev ||
      after.ino !== pathAfter.ino ||
      after.mode !== pathAfter.mode ||
      after.size !== pathAfter.size ||
      after.mtimeNs !== pathAfter.mtimeNs ||
      after.ctimeNs !== pathAfter.ctimeNs
    ) {
      throw new DurableFileReadError("file_changed", `${options.label} changed while it was read`);
    }
    return value;
  } finally {
    await handle.close();
  }
}

function isCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
