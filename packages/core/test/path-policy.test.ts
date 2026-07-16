import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PathAuthorityError, WorktreePathAuthority } from "../src/authority/path-policy.js";
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
    await expect(policy.write("value.txt", Buffer.from("two"), rawSha256("wrong")))
      .rejects.toMatchObject({ code: "write_cas" } satisfies Partial<PathAuthorityError>);
    await expect(policy.write("redirect/file", Buffer.from("bad"), null))
      .rejects.toMatchObject({ code: "symlink" } satisfies Partial<PathAuthorityError>);
    await expect(policy.read("../outside")).rejects.toMatchObject({ code: "path_escape" });
    await expect(WorktreePathAuthority.create(root, { readPaths: [], writePaths: [".git/config"] }))
      .rejects.toMatchObject({ code: "compiler_owned" });
  });
});

async function temporary(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-path-policy-"));
  roots.push(root);
  return root;
}
