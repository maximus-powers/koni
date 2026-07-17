import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Create one file without replacement through a fully synced sibling temp inode.
 * A crash exposes either no destination or the complete destination bytes; stale private temps
 * are inert and may be removed by later maintenance.
 */
export async function createFileAtomicallyNoReplace(
  destination: string,
  bytes: string | Uint8Array,
  mode: number,
): Promise<boolean> {
  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  let published = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, destination);
      published = true;
    } catch (error) {
      if (isCode(error, "EEXIST")) return false;
      throw error;
    }
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return true;
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isCode(error, "ENOENT") && !published) throw error;
    });
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
