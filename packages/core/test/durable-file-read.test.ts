import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DurableFileReadError,
  hashStableDurableFile,
  readStableDurableFile,
} from "../src/authority/durable-file-read.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureFile(bytes = "abcdef"): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-durable-read-"));
  roots.push(root);
  const file = path.join(root, "value.bin");
  await writeFile(file, bytes);
  return { root, file };
}

describe("descriptor-pinned durable file reads", () => {
  it("loops over positional partial reads without duplicating or skipping bytes", async () => {
    const { file } = await fixtureFile("abcdefghij");
    const bytes = await readStableDurableFile(file, {
      maximum: 10,
      label: "partial fixture",
      testHooks: {
        read: (handle, buffer, offset, length, position) =>
          handle.read(buffer, offset, Math.min(length, 2), position),
      },
    });
    expect(bytes.toString("utf8")).toBe("abcdefghij");
  });

  it("rejects deterministic truncation after descriptor stat as file_changed", async () => {
    const { file } = await fixtureFile();
    await expect(
      readStableDurableFile(file, {
        maximum: 6,
        label: "truncated fixture",
        testHooks: { afterOpenStat: () => truncate(file, 2) },
      }),
    ).rejects.toMatchObject({ code: "file_changed" } satisfies Partial<DurableFileReadError>);
  });

  it("rejects deterministic growth through the positional EOF probe", async () => {
    const { file } = await fixtureFile();
    await expect(
      readStableDurableFile(file, {
        maximum: 7,
        label: "grown fixture",
        testHooks: { afterOpenStat: () => appendFile(file, "g") },
      }),
    ).rejects.toMatchObject({ code: "file_size" } satisfies Partial<DurableFileReadError>);
  });

  it("rejects path replacement after reading the original descriptor", async () => {
    const { root, file } = await fixtureFile();
    const replacement = path.join(root, "replacement.bin");
    await writeFile(replacement, "abcdef");
    await expect(
      readStableDurableFile(file, {
        maximum: 6,
        label: "replaced fixture",
        testHooks: { beforeIdentityCheck: () => rename(replacement, file) },
      }),
    ).rejects.toMatchObject({ code: "file_changed" } satisfies Partial<DurableFileReadError>);
  });

  it("rejects disappearance after reading the open descriptor", async () => {
    const { file } = await fixtureFile();
    await expect(
      readStableDurableFile(file, {
        maximum: 6,
        label: "removed fixture",
        testHooks: { beforeIdentityCheck: () => unlink(file) },
      }),
    ).rejects.toMatchObject({ code: "file_changed" } satisfies Partial<DurableFileReadError>);
  });

  it("rejects symlinks, directories, and oversized regular files before allocation", async () => {
    const { root, file } = await fixtureFile();
    const link = path.join(root, "link.bin");
    const directory = path.join(root, "directory");
    await symlink(file, link);
    await mkdir(directory);
    await expect(readStableDurableFile(link, { maximum: 6, label: "link" })).rejects.toMatchObject({
      code: "file_type",
    } satisfies Partial<DurableFileReadError>);
    await expect(
      readStableDurableFile(directory, { maximum: 6, label: "directory" }),
    ).rejects.toMatchObject({ code: "file_type" } satisfies Partial<DurableFileReadError>);
    await expect(
      readStableDurableFile(file, { maximum: 5, label: "oversized" }),
    ).rejects.toMatchObject({ code: "file_size" } satisfies Partial<DurableFileReadError>);
  });

  it("hashes incrementally through the same positional and identity checks", async () => {
    const { file } = await fixtureFile("abcdefghij");
    const actual = await hashStableDurableFile(file, {
      maximum: 10,
      minimum: 0,
      label: "hash fixture",
      testHooks: {
        read: (handle, buffer, offset, length, position) =>
          handle.read(buffer, offset, Math.min(length, 3), position),
      },
    });
    const expected = `sha256:${createHash("sha256").update("abcdefghij").digest("hex")}`;
    expect(actual).toBe(expected);
  });
});
