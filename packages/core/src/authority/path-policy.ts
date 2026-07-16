import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { rawSha256, type Sha256Digest } from "../shared/canonical.js";

const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_WRITE_BYTES = 16 * 1024 * 1024;

export class PathAuthorityError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "PathAuthorityError";
    this.code = code;
  }
}

export class WorktreePathAuthority {
  readonly #root: string;
  readonly #readRoots: readonly string[];
  readonly #writeRoots: readonly string[];

  private constructor(root: string, readRoots: readonly string[], writeRoots: readonly string[]) {
    this.#root = root;
    this.#readRoots = readRoots;
    this.#writeRoots = writeRoots;
  }

  public static async create(
    worktreeRoot: string,
    grants: { readPaths: readonly string[]; writePaths: readonly string[] },
  ): Promise<WorktreePathAuthority> {
    const root = await realpath(worktreeRoot);
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new PathAuthorityError("unsafe_root", "worktree authority root must be a real directory");
    }
    return new WorktreePathAuthority(
      root,
      normalizeRoots(grants.readPaths, false),
      normalizeRoots(grants.writePaths, true),
    );
  }

  public async read(relative: string): Promise<{ bytes: Buffer; sha256: Sha256Digest }> {
    const normalized = normalizeRelative(relative);
    this.#requireScope(normalized, this.#readRoots, "read_scope");
    const absolute = await this.#safeAbsolute(normalized, false);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_READ_BYTES) {
      throw new PathAuthorityError("read_type", "read target is not a bounded regular file");
    }
    const bytes = await readFile(absolute);
    return { bytes, sha256: rawSha256(bytes) };
  }

  public async write(
    relative: string,
    bytes: Uint8Array,
    expectedSha256: Sha256Digest | null,
  ): Promise<Sha256Digest> {
    if (bytes.byteLength > MAX_WRITE_BYTES) {
      throw new PathAuthorityError("write_size", `write exceeds ${MAX_WRITE_BYTES} bytes`);
    }
    const normalized = normalizeRelative(relative);
    this.#requireScope(normalized, this.#writeRoots, "write_scope");
    rejectCompilerOwned(normalized);
    const absolute = await this.#safeAbsolute(normalized, true);
    const current = await readOptionalRegularFile(absolute);
    const actual = current === undefined ? null : rawSha256(current);
    if (actual !== expectedSha256) {
      throw new PathAuthorityError("write_cas", `write target changed: ${normalized}`);
    }
    await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
    await this.#safeAbsolute(normalized, true);
    const temporary = `${absolute}.koni-${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, absolute);
      await syncDirectory(path.dirname(absolute));
    } finally {
      await rm(temporary, { force: true });
    }
    return rawSha256(bytes);
  }

  public async edit(
    relative: string,
    oldText: string,
    newText: string,
    expectedSha256: Sha256Digest,
  ): Promise<Sha256Digest> {
    if (oldText.length === 0 || oldText === newText) {
      throw new PathAuthorityError("edit_input", "edit must replace nonempty text with different text");
    }
    const current = await this.read(relative);
    if (current.sha256 !== expectedSha256) {
      throw new PathAuthorityError("write_cas", `edit target changed: ${relative}`);
    }
    const text = current.bytes.toString("utf8");
    const first = text.indexOf(oldText);
    if (first < 0 || text.indexOf(oldText, first + oldText.length) >= 0) {
      throw new PathAuthorityError("edit_match", "edit text must match exactly once");
    }
    return this.write(relative, Buffer.from(text.slice(0, first) + newText + text.slice(first + oldText.length)), expectedSha256);
  }

  #requireScope(relative: string, roots: readonly string[], code: string): void {
    if (!roots.some((root) => root === "." || relative === root || relative.startsWith(`${root}/`))) {
      throw new PathAuthorityError(code, `${relative} is outside the compiled path grant`);
    }
  }

  async #safeAbsolute(relative: string, allowMissingLeaf: boolean): Promise<string> {
    const absolute = path.resolve(this.#root, relative);
    if (absolute !== this.#root && !absolute.startsWith(`${this.#root}${path.sep}`)) {
      throw new PathAuthorityError("path_escape", "path escapes the worktree root");
    }
    const parts = relative === "." ? [] : relative.split("/");
    let cursor = this.#root;
    for (const [index, part] of parts.entries()) {
      cursor = path.join(cursor, part);
      try {
        const metadata = await lstat(cursor);
        if (metadata.isSymbolicLink()) {
          throw new PathAuthorityError("symlink", `path traverses a symlink: ${relative}`);
        }
        if (index < parts.length - 1 && !metadata.isDirectory()) {
          throw new PathAuthorityError("path_type", `path parent is not a directory: ${relative}`);
        }
      } catch (error) {
        if (error instanceof PathAuthorityError) throw error;
        if (!isCode(error, "ENOENT")) throw error;
        if (!allowMissingLeaf && index === parts.length - 1) throw error;
        break;
      }
    }
    return absolute;
  }
}

function normalizeRoots(values: readonly string[], write: boolean): string[] {
  const roots = [...new Set(values.map(normalizeRelative))].sort();
  if (write) roots.forEach(rejectCompilerOwned);
  return roots.filter((root, index) => !roots.some((other, otherIndex) =>
    otherIndex !== index && (other === "." || root.startsWith(`${other}/`))
  ));
}

function normalizeRelative(value: string): string {
  if (
    value === "." ||
    (value.length > 0 &&
      !path.isAbsolute(value) &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
  ) return value;
  throw new PathAuthorityError("path_escape", `unsafe project-relative path: ${value}`);
}

function rejectCompilerOwned(relative: string): void {
  const first = relative.split("/")[0];
  if (first === ".git" || first === ".koni") {
    throw new PathAuthorityError("compiler_owned", `${first} is compiler-owned and cannot be granted`);
  }
}

async function readOptionalRegularFile(file: string): Promise<Buffer | undefined> {
  try {
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new PathAuthorityError("path_type", "write target is not a regular file");
    }
    return await readFile(file);
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
