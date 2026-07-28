import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type PathAuthorityError, WorktreePathAuthority } from "../src/authority/path-policy.js";
import { rawSha256 } from "../src/shared/canonical.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("worktree path authority", () => {
  it("provides CAS read/edit/write only under compiled grants", async () => {
    const root = await temporary();
    await writeFile(path.join(root, "allowed.txt"), "before\n");
    await writeFile(path.join(root, "secret.txt"), "secret\n");
    const policy = await WorktreePathAuthority.create(root, {
      readPaths: ["allowed.txt"],
      writePaths: ["allowed.txt", "new/file.txt"],
    });
    const before = await policy.read("allowed.txt");
    await policy.edit("allowed.txt", "before", "after", before.sha256);
    expect(await readFile(path.join(root, "allowed.txt"), "utf8")).toBe("after\n");
    await policy.write("new/file.txt", Buffer.from("new\n"), null);
    await expect(policy.read("secret.txt")).rejects.toMatchObject({ code: "read_scope" });
  });

  it("rejects stale writes, symlinks, escapes, and compiler-owned paths", async () => {
    const root = await temporary();
    const outside = await temporary();
    await writeFile(path.join(root, "value.txt"), "one");
    await symlink(outside, path.join(root, "redirect"));
    const policy = await WorktreePathAuthority.create(root, {
      readPaths: ["value.txt", "redirect/file"],
      writePaths: ["value.txt", "redirect/file"],
    });
    await expect(
      policy.write("value.txt", Buffer.from("two"), rawSha256("wrong")),
    ).rejects.toMatchObject({ code: "write_cas" } satisfies Partial<PathAuthorityError>);
    await expect(policy.write("redirect/file", Buffer.from("bad"), null)).rejects.toMatchObject({
      code: "symlink",
    } satisfies Partial<PathAuthorityError>);
    await expect(policy.read("../outside")).rejects.toMatchObject({ code: "path_escape" });
    await expect(
      WorktreePathAuthority.create(root, { readPaths: [], writePaths: [".git/config"] }),
    ).rejects.toMatchObject({ code: "compiler_owned" });
  });

  it("lists and searches only bounded regular files inside the read grant", async () => {
    const root = await temporary();
    const outside = await temporary();
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    await writeFile(path.join(root, "src", "one.ts"), "export const needle = 1;\n");
    await writeFile(path.join(root, "src", "nested", "two.ts"), "// Needle again\n");
    await writeFile(path.join(root, "secret.txt"), "needle secret\n");
    await writeFile(path.join(outside, "outside.ts"), "needle outside\n");
    await symlink(outside, path.join(root, "src", "redirect"));
    const policy = await WorktreePathAuthority.create(root, {
      readPaths: ["src"],
      writePaths: [],
    });

    expect(await policy.list("src", { recursive: true })).toEqual([
      { path: "src/nested", kind: "directory", sizeBytes: 0 },
      { path: "src/one.ts", kind: "file", sizeBytes: 25 },
      { path: "src/nested/two.ts", kind: "file", sizeBytes: 16 },
    ]);
    expect(await policy.search("needle", { roots: ["src"], caseSensitive: false })).toEqual([
      { path: "src/nested/two.ts", line: 1, column: 4, byteOffset: 3, preview: "// Needle again" },
      {
        path: "src/one.ts",
        line: 1,
        column: 14,
        byteOffset: 13,
        preview: "export const needle = 1;",
      },
    ]);
    await expect(policy.list(".")).rejects.toMatchObject({ code: "read_scope" });
    await expect(policy.search("needle", { roots: ["secret.txt"] })).rejects.toMatchObject({
      code: "read_scope",
    });
  });

  it("returns UTF-8 byte offsets that can page directly into a multibyte CRLF file", async () => {
    const root = await temporary();
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "multibyte.ts"), "α\r\nneedle here\n");
    const policy = await WorktreePathAuthority.create(root, {
      readPaths: ["src/multibyte.ts"],
      writePaths: [],
    });

    expect(await policy.search("needle")).toEqual([
      {
        path: "src/multibyte.ts",
        line: 2,
        column: 1,
        byteOffset: 4,
        preview: "needle here",
      },
    ]);
  });
});

async function temporary(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-path-policy-"));
  roots.push(root);
  return root;
}
