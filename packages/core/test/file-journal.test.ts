import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileJournalError, FileTransactionStore } from "../src/authority/file-journal.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const result = await mkdtemp(path.join(tmpdir(), "koni-journal-"));
  roots.push(result);
  return result;
}

describe("file transaction journal", () => {
  it("publishes a prepared multi-file transaction and replays commit idempotently", async () => {
    const directory = await root();
    await writeFile(path.join(directory, "old.txt"), "old");
    const store = await FileTransactionStore.open(directory);
    await store.prepare(
      "tx-one",
      [
        { path: "nested/new.txt", bytes: Buffer.from("new"), expectedSha256: null },
        { path: "old.txt", bytes: Buffer.from("replacement") },
      ],
      [],
    );
    await store.commit("tx-one");
    await store.commit("tx-one");
    expect(await readFile(path.join(directory, "nested/new.txt"), "utf8")).toBe("new");
    expect(await readFile(path.join(directory, "old.txt"), "utf8")).toBe("replacement");
  });

  it("recovers every prepared transaction in stable order", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    await store.prepare("tx-b", [{ path: "b.txt", bytes: Buffer.from("b") }]);
    await store.prepare("tx-a", [{ path: "a.txt", bytes: Buffer.from("a") }]);
    expect(await store.recoverPrepared()).toEqual(["tx-a", "tx-b"]);
    expect(await readFile(path.join(directory, "a.txt"), "utf8")).toBe("a");
    expect(await readFile(path.join(directory, "b.txt"), "utf8")).toBe("b");
  });

  it("fails closed when an expected file changed", async () => {
    const directory = await root();
    await writeFile(path.join(directory, "value.txt"), "one");
    const store = await FileTransactionStore.open(directory);
    await expect(
      store.prepare("tx-one", [
        {
          path: "value.txt",
          bytes: Buffer.from("two"),
          expectedSha256: "sha256:not-the-current-value",
        },
      ]),
    ).rejects.toMatchObject({ code: "expected_hash" } satisfies Partial<FileJournalError>);
  });

  it("rejects symlink traversal and path escape", async () => {
    const directory = await root();
    const outside = await root();
    await symlink(outside, path.join(directory, "redirect"));
    const store = await FileTransactionStore.open(directory);
    await expect(
      store.prepare("tx-one", [{ path: "redirect/file", bytes: Buffer.from("unsafe") }]),
    ).rejects.toMatchObject({ code: "symlink" } satisfies Partial<FileJournalError>);
    await expect(
      store.prepare("tx-two", [{ path: "../outside", bytes: Buffer.from("unsafe") }]),
    ).rejects.toMatchObject({ code: "path_escape" } satisfies Partial<FileJournalError>);
  });
});
