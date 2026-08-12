import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { rawSha256, type Sha256Digest } from "../shared/canonical.js";

const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_WRITE_BYTES = 16 * 1024 * 1024;
const MAX_LIST_ENTRIES = 10_000;
const MAX_SEARCH_FILES = 10_000;
const MAX_SEARCH_BYTES = 32 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 1_000;
/**
 * A literal UTF-8 search cannot match inside these, and reading them anyway spends the byte budget
 * on content that can never produce a result — a handful of images in a research repository
 * exhausted it before any source file was reached, and the agent saw only "narrow your roots".
 * Content-sniffing already discards binaries after the read; this declines to pay for them first.
 */
const NON_TEXT_SEARCH_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".tiff",
  ".avif",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".zst",
  ".7z",
  ".rar",
  ".jar",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".webm",
  ".mov",
  ".avi",
  ".mkv",
  ".flac",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".bin",
  ".o",
  ".a",
  ".class",
  ".wasm",
  ".pyc",
  ".pyd",
  ".npy",
  ".npz",
  ".pt",
  ".pth",
  ".ckpt",
  ".safetensors",
  ".parquet",
  ".arrow",
  ".feather",
  ".h5",
  ".hdf5",
  ".pkl",
  ".pickle",
  ".db",
  ".sqlite",
]);

function isNonTextSearchCandidate(relativePath: string): boolean {
  return NON_TEXT_SEARCH_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

export interface AuthorizedPathEntry {
  path: string;
  kind: "file" | "directory";
  sizeBytes: number;
}

export interface AuthorizedSearchMatch {
  path: string;
  line: number;
  column: number;
  /** UTF-8 byte offset accepted directly by koni_read_file's offset argument. */
  byteOffset: number;
  preview: string;
}

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
      throw new PathAuthorityError(
        "unsafe_root",
        "worktree authority root must be a real directory",
      );
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
    const current = await readOptionalRegularFile(absolute, MAX_WRITE_BYTES);
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

  /** Snapshot a writable target for a crash-forward edit plan without broadening read scope. */
  public async inspectWritable(
    relative: string,
  ): Promise<{ bytes: Buffer; sha256: Sha256Digest } | undefined> {
    const normalized = normalizeRelative(relative);
    this.#requireScope(normalized, this.#writeRoots, "write_scope");
    rejectCompilerOwned(normalized);
    const absolute = await this.#safeAbsolute(normalized, true);
    const bytes = await readOptionalRegularFile(absolute, MAX_WRITE_BYTES);
    return bytes === undefined ? undefined : { bytes, sha256: rawSha256(bytes) };
  }

  public async edit(
    relative: string,
    oldText: string,
    newText: string,
    expectedSha256: Sha256Digest,
  ): Promise<Sha256Digest> {
    if (oldText.length === 0 || oldText === newText) {
      throw new PathAuthorityError(
        "edit_input",
        "edit must replace nonempty text with different text",
      );
    }
    const current = await this.inspectWritable(relative);
    if (current === undefined || current.sha256 !== expectedSha256) {
      throw new PathAuthorityError("write_cas", `edit target changed: ${relative}`);
    }
    const text = current.bytes.toString("utf8");
    const first = text.indexOf(oldText);
    if (first < 0 || text.indexOf(oldText, first + oldText.length) >= 0) {
      throw new PathAuthorityError("edit_match", "edit text must match exactly once");
    }
    return this.write(
      relative,
      Buffer.from(text.slice(0, first) + newText + text.slice(first + oldText.length)),
      expectedSha256,
    );
  }

  /** List a bounded, grant-filtered directory tree without following symlinks. */
  public async list(
    relative: string,
    options: { recursive?: boolean; limit?: number } = {},
  ): Promise<AuthorizedPathEntry[]> {
    const normalized = normalizeRelative(relative);
    this.#requireScope(normalized, this.#readRoots, "read_scope");
    const absolute = await this.#safeAbsolute(normalized, false);
    const metadata = await lstat(absolute);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new PathAuthorityError("list_type", "list target is not a real directory");
    }
    const limit = boundedLimit(options.limit, MAX_LIST_ENTRIES, "list limit");
    const output: AuthorizedPathEntry[] = [];
    const queue = [{ relative: normalized, absolute }];
    while (queue.length > 0 && output.length < limit) {
      const current = queue.shift()!;
      const children = await readdir(current.absolute, { withFileTypes: true });
      children.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
      for (const child of children) {
        if (output.length >= limit) break;
        const childRelative =
          current.relative === "." ? child.name : `${current.relative}/${child.name}`;
        if (!this.#isWithinScope(childRelative, this.#readRoots)) continue;
        const childAbsolute = path.join(current.absolute, child.name);
        const childMetadata = await lstat(childAbsolute);
        if (childMetadata.isSymbolicLink()) continue;
        if (childMetadata.isDirectory()) {
          output.push({ path: childRelative, kind: "directory", sizeBytes: 0 });
          if (options.recursive === true)
            queue.push({ relative: childRelative, absolute: childAbsolute });
        } else if (childMetadata.isFile()) {
          output.push({ path: childRelative, kind: "file", sizeBytes: childMetadata.size });
        }
      }
    }
    return output;
  }

  /** Literal UTF-8 search over bounded regular files in the exact read grant. */
  public async search(
    query: string,
    options: { roots?: readonly string[]; limit?: number; caseSensitive?: boolean } = {},
  ): Promise<AuthorizedSearchMatch[]> {
    if (
      query.length === 0 ||
      Buffer.byteLength(query, "utf8") > 4 * 1024 ||
      query.includes("\u0000")
    ) {
      throw new PathAuthorityError(
        "search_query",
        "search query is empty, oversized, or contains NUL",
      );
    }
    const roots =
      options.roots?.length === 0 || options.roots === undefined
        ? this.#readRoots
        : [...new Set(options.roots.map((value) => normalizeRelative(value)))];
    for (const root of roots) this.#requireScope(root, this.#readRoots, "read_scope");
    const limit = boundedLimit(options.limit, MAX_SEARCH_RESULTS, "search limit");
    const files = new Set<string>();
    for (const root of roots) {
      const absolute = await this.#safeAbsolute(root, false);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isFile()) {
        files.add(root);
      } else if (metadata.isDirectory()) {
        for (const entry of await this.list(root, { recursive: true, limit: MAX_SEARCH_FILES })) {
          if (
            entry.kind === "file" &&
            entry.sizeBytes <= MAX_READ_BYTES &&
            !isNonTextSearchCandidate(entry.path)
          ) {
            files.add(entry.path);
          }
        }
      }
      if (files.size > MAX_SEARCH_FILES) {
        throw new PathAuthorityError(
          "search_files",
          `search spans more than ${MAX_SEARCH_FILES} files. Narrow "roots" to a specific subdirectory (for example an app's src directory) rather than a package or repository root, which scans dependency and build output.`,
        );
      }
    }
    const needle = options.caseSensitive === false ? query.toLocaleLowerCase("en-US") : query;
    const matches: AuthorizedSearchMatch[] = [];
    let scannedBytes = 0;
    for (const file of [...files].sort((left, right) =>
      Buffer.from(left).compare(Buffer.from(right)),
    )) {
      const result = await this.read(file);
      scannedBytes += result.bytes.byteLength;
      if (scannedBytes > MAX_SEARCH_BYTES) {
        throw new PathAuthorityError(
          "search_bytes",
          `search scanned more than ${MAX_SEARCH_BYTES} bytes before matching. Narrow "roots" to a specific subdirectory (for example an app's src directory); a package or repository root scans large dependency and build files.`,
        );
      }
      if (result.bytes.includes(0)) continue;
      const text = result.bytes.toString("utf8");
      const lines = text.split(/\r?\n/u);
      let lineStartCharacter = 0;
      let lineStartByte = 0;
      for (const [index, rawLine] of lines.entries()) {
        const haystack =
          options.caseSensitive === false ? rawLine.toLocaleLowerCase("en-US") : rawLine;
        let offset = 0;
        while (matches.length < limit) {
          const found = haystack.indexOf(needle, offset);
          if (found < 0) break;
          matches.push({
            path: file,
            line: index + 1,
            column: found + 1,
            byteOffset: lineStartByte + Buffer.byteLength(rawLine.slice(0, found), "utf8"),
            preview: boundedPreview(rawLine),
          });
          offset = found + Math.max(needle.length, 1);
        }
        if (matches.length >= limit) return matches;
        const newlineStart = lineStartCharacter + rawLine.length;
        const newlineCharacters = text.startsWith("\r\n", newlineStart)
          ? 2
          : text.startsWith("\n", newlineStart)
            ? 1
            : 0;
        lineStartCharacter = newlineStart + newlineCharacters;
        lineStartByte += Buffer.byteLength(rawLine, "utf8") + newlineCharacters;
      }
    }
    return matches;
  }

  #requireScope(relative: string, roots: readonly string[], code: string): void {
    if (!this.#isWithinScope(relative, roots)) {
      throw new PathAuthorityError(code, `${relative} is outside the compiled path grant`);
    }
  }

  #isWithinScope(relative: string, roots: readonly string[]): boolean {
    return roots.some(
      (root) => root === "." || relative === root || relative.startsWith(`${root}/`),
    );
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

function boundedLimit(value: number | undefined, maximum: number, label: string): number {
  const resolved = value ?? Math.min(maximum, 1_000);
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new PathAuthorityError("limit", `${label} must be between 1 and ${maximum}`);
  }
  return resolved;
}

function boundedPreview(value: string): string {
  const normalized = value.replaceAll("\t", "  ");
  return normalized.length <= 512 ? normalized : `${normalized.slice(0, 509)}...`;
}

function normalizeRoots(values: readonly string[], write: boolean): string[] {
  const roots = [...new Set(values.map(normalizeRelative))].sort();
  if (write) roots.forEach(rejectCompilerOwned);
  return roots.filter(
    (root, index) =>
      !roots.some(
        (other, otherIndex) =>
          otherIndex !== index && (other === "." || root.startsWith(`${other}/`)),
      ),
  );
}

function normalizeRelative(value: string): string {
  if (
    value === "." ||
    (value.length > 0 &&
      !path.isAbsolute(value) &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
  )
    return value;
  throw new PathAuthorityError("path_escape", `unsafe project-relative path: ${value}`);
}

function rejectCompilerOwned(relative: string): void {
  const first = relative.split("/")[0];
  if (first === ".git" || first === ".koni") {
    throw new PathAuthorityError(
      "compiler_owned",
      `${first} is compiler-owned and cannot be granted`,
    );
  }
}

async function readOptionalRegularFile(file: string, maximum: number): Promise<Buffer | undefined> {
  try {
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maximum) {
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
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
