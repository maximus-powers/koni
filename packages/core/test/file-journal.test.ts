import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  link,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type FileJournalError, FileTransactionStore } from "../src/authority/file-journal.js";
import {
  AsyncSemaphore,
  mapBoundedDrained,
  MAX_RUN_BYTES,
  MAX_JOURNAL_BYTES,
  MAX_STATE_BYTES,
  MAX_TRANSACTION_BYTES,
  MAX_TRANSACTION_EFFECTS,
  transactionPayloadBytes,
} from "../src/authority/durable-limits.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

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
    await expect(
      stat(path.join(directory, ".transactions", "tx-one", "journal.json.prepare")),
    ).rejects.toMatchObject({ code: "ENOENT" });
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

  it("durably discards only a real pre-journal orphan and still replays journaled work", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    await writeFile(path.join(directory, "prior.txt"), "prior");
    await store.prepare("tx-orphan", [
      {
        path: "prior.txt",
        bytes: Buffer.from("orphan replacement"),
        expectedSha256: digestBytes(Buffer.from("prior")),
      },
    ]);
    await store.prepare("tx-journaled", [
      { path: "published.txt", bytes: Buffer.from("published") },
    ]);
    const orphan = path.join(directory, ".transactions", "tx-orphan");
    const orphanStage = path.join(orphan, "stage", "000000");
    expect(await readFile(orphanStage, "utf8")).toBe("orphan replacement");
    await unlink(path.join(orphan, "journal.json"));

    const reopened = await FileTransactionStore.open(directory);
    await expect(reopened.recoverPrepared()).resolves.toEqual(["tx-journaled"]);
    expect(await readFile(path.join(directory, "prior.txt"), "utf8")).toBe("prior");
    expect(await readFile(path.join(directory, "published.txt"), "utf8")).toBe("published");
    expect(await readdir(path.join(directory, ".transactions"))).toEqual([]);

    const reopenedAgain = await FileTransactionStore.open(directory);
    await expect(reopenedAgain.recoverPrepared()).resolves.toEqual([]);
  });

  it("does not follow a symlinked no-journal transaction entry", async () => {
    const directory = await root();
    const outside = await root();
    await mkdir(path.join(outside, "stage"));
    await writeFile(path.join(outside, "stage", "000000"), "outside");
    const store = await FileTransactionStore.open(directory);
    const link = path.join(directory, ".transactions", "tx-linked-orphan");
    await symlink(outside, link);

    await expect(store.recoverPrepared()).resolves.toEqual([]);
    expect(await readFile(path.join(outside, "stage", "000000"), "utf8")).toBe("outside");
    expect((await stat(link)).isDirectory()).toBe(true);
  });

  it("resumes bounded cleanup after an earlier orphan-stage unlink", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    const id = "tx-orphan-prefix";
    await store.prepare(id, [
      { path: "one.txt", bytes: Buffer.from("one") },
      { path: "two.txt", bytes: Buffer.from("two") },
    ]);
    const transaction = path.join(directory, ".transactions", id);
    await unlink(path.join(transaction, "journal.json"));
    await unlink(path.join(transaction, "stage", "000000"));

    await expect(store.recoverPrepared()).resolves.toEqual([]);
    await expect(stat(transaction)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { name: "empty", bytes: Buffer.alloc(0) },
    { name: "partial", bytes: Buffer.from('{"protocol":"koni.file-transaction.v1"') },
  ])(
    "removes an exact unpublished $name journal temp without interpreting it",
    async ({ name, bytes }) => {
      const directory = await root();
      const store = await FileTransactionStore.open(directory);
      const id = `tx-journal-temp-${name}`;
      await store.prepare(id, [{ path: "value.txt", bytes: Buffer.from("next") }]);
      const transaction = path.join(directory, ".transactions", id);
      await unlink(path.join(transaction, "journal.json"));
      const temporary = path.join(transaction, "journal.json.prepare");
      await writeFile(temporary, bytes);

      const reopened = await FileTransactionStore.open(directory);
      await expect(reopened.recoverPrepared()).resolves.toEqual([]);
      await expect(stat(transaction)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(path.join(directory, "value.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("recovers a fully published journal when its private hard-link name survived the crash", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    const id = "tx-journal-link-prefix";
    await store.prepare(id, [{ path: "value.txt", bytes: Buffer.from("next") }]);
    const transaction = path.join(directory, ".transactions", id);
    await link(
      path.join(transaction, "journal.json"),
      path.join(transaction, "journal.json.prepare"),
    );

    const reopened = await FileTransactionStore.open(directory);
    await expect(reopened.recoverPrepared()).resolves.toEqual([id]);
    expect(await readFile(path.join(directory, "value.txt"), "utf8")).toBe("next");
    await expect(stat(transaction)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an orphan stage outside the generatable effect range", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    const transaction = path.join(directory, ".transactions", "tx-orphan-range");
    await mkdir(path.join(transaction, "stage"), { recursive: true });
    await writeFile(path.join(transaction, "stage", "100000"), "unpublished");

    await expect(store.recoverPrepared()).rejects.toMatchObject({
      code: "unpublished_shape",
    } satisfies Partial<FileJournalError>);
    expect(await readFile(path.join(transaction, "stage", "100000"), "utf8")).toBe("unpublished");
  });

  it("recovers the exact stage-to-temporary handoff and cleans it idempotently", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    const destination = path.join(directory, "value.txt");
    await writeFile(destination, "prior");
    const id = "tx-temp-handoff";
    await store.prepare(id, [
      {
        path: "value.txt",
        bytes: Buffer.from("next"),
        expectedSha256: digestBytes(Buffer.from("prior")),
      },
    ]);
    const transaction = path.join(directory, ".transactions", id);
    const stage = path.join(transaction, "stage", "000000");
    const temporary = `${destination}.koni-${id}.tmp`;
    await rename(stage, temporary);

    const reopened = await FileTransactionStore.open(directory);
    await expect(reopened.recoverPrepared()).resolves.toEqual([id]);
    expect(await readFile(destination, "utf8")).toBe("next");
    await expect(stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(transaction)).rejects.toMatchObject({ code: "ENOENT" });
    const reopenedAgain = await FileTransactionStore.open(directory);
    await expect(reopenedAgain.recoverPrepared()).resolves.toEqual([]);
  });

  it("fails closed and preserves a stray temporary while the authoritative stage remains", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    const id = "tx-stage-preferred";
    const destination = path.join(directory, "value.txt");
    await store.prepare(id, [{ path: "value.txt", bytes: Buffer.from("next") }]);
    const temporary = `${destination}.koni-${id}.tmp`;
    await writeFile(temporary, "evil");

    await expect(store.commit(id)).rejects.toMatchObject({ code: "temporary_exists" });
    expect(await readFile(temporary, "utf8")).toBe("evil");
    expect(
      await readFile(path.join(directory, ".transactions", id, "stage", "000000"), "utf8"),
    ).toBe("next");
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      JSON.parse(await readFile(path.join(directory, ".transactions", id, "journal.json"), "utf8")),
    ).toMatchObject({ status: "prepared" });
  });

  it("recovers the exact exclusive-link crash prefix where stage and handoff name one inode", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    const id = "tx-linked-handoff";
    const destination = path.join(directory, "value.txt");
    await store.prepare(id, [{ path: "value.txt", bytes: Buffer.from("next") }]);
    const stage = path.join(directory, ".transactions", id, "stage", "000000");
    const temporary = `${destination}.koni-${id}.tmp`;
    await link(stage, temporary);

    const reopened = await FileTransactionStore.open(directory);
    await expect(reopened.recoverPrepared()).resolves.toEqual([id]);
    expect(await readFile(destination, "utf8")).toBe("next");
    await expect(stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(directory, ".transactions", id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a pre-existing derived handoff before publishing transaction state", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    const id = "tx-existing-handoff";
    const temporary = path.join(directory, `value.txt.koni-${id}.tmp`);
    await writeFile(temporary, "unrelated");

    await expect(
      store.prepare(id, [{ path: "value.txt", bytes: Buffer.from("next") }]),
    ).rejects.toMatchObject({ code: "temporary_exists" });
    expect(await readFile(temporary, "utf8")).toBe("unrelated");
    await expect(stat(path.join(directory, ".transactions", id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reserves the portable transaction-authority namespace before prepare", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    await expect(
      store.prepare("tx-internal", [
        {
          path: ".TRANSACTIONS/tx-internal/journal.json",
          bytes: Buffer.from("overwrite"),
        },
      ]),
    ).rejects.toMatchObject({ code: "reserved_path" });
    expect(await readdir(path.join(directory, ".transactions"))).toEqual([]);
  });

  it("rejects a trailing-slash destination before publishing transaction state", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    await expect(
      store.prepare("tx-trailing-slash", [
        {
          path: "foo/",
          bytes: Buffer.from("not a leaf"),
        },
      ]),
    ).rejects.toMatchObject({ code: "path_shape" });
    expect(await readdir(path.join(directory, ".transactions"))).toEqual([]);
    await expect(stat(path.join(directory, "foo"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects write and delete effects whose existing leaf is a directory before prepare", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    const target = path.join(directory, "existing-directory");
    await mkdir(target);

    await expect(
      store.prepare("tx-directory-write", [
        {
          path: "existing-directory",
          bytes: Buffer.from("file bytes"),
        },
      ]),
    ).rejects.toMatchObject({ code: "path_type" });
    await expect(
      store.prepare(
        "tx-directory-delete",
        [],
        [
          {
            path: "existing-directory",
          },
        ],
      ),
    ).rejects.toMatchObject({ code: "path_type" });

    expect((await stat(target)).isDirectory()).toBe(true);
    expect(await readdir(target)).toEqual([]);
    expect(await readdir(path.join(directory, ".transactions"))).toEqual([]);
  });

  it("rejects declared and derived path-segment overlaps before staging", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    await expect(
      store.prepare("tx-declared-overlap", [
        { path: "foo", bytes: Buffer.from("parent") },
        { path: "foo/bar", bytes: Buffer.from("child") },
      ]),
    ).rejects.toMatchObject({ code: "path_overlap" });

    const id = "tx-derived-overlap";
    await expect(
      store.prepare(id, [
        { path: "foo", bytes: Buffer.from("parent") },
        { path: `foo.koni-${id}.tmp/bar`, bytes: Buffer.from("child") },
      ]),
    ).rejects.toMatchObject({ code: "temporary_path_collision" });
    expect(await readdir(path.join(directory, ".transactions"))).toEqual([]);
  });

  it("rejects declared destinations that alias an internal handoff path before staging", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    const id = "tx-alias";
    await expect(
      store.prepare(id, [
        { path: `value.txt.koni-${id}.tmp`, bytes: Buffer.from("first") },
        { path: "value.txt", bytes: Buffer.from("second") },
      ]),
    ).rejects.toMatchObject({
      code: "temporary_path_collision",
    } satisfies Partial<FileJournalError>);
    await expect(
      store.prepare(
        "tx-delete-alias",
        [{ path: "value.txt", bytes: Buffer.from("value") }],
        [{ path: "VALUE.TXT.KONI-TX-DELETE-ALIAS.TMP" }],
      ),
    ).rejects.toMatchObject({
      code: "temporary_path_collision",
    } satisfies Partial<FileJournalError>);
    await expect(stat(path.join(directory, ".transactions", id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a journaled handoff alias before replay can delete a declared output", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    const id = "tx-replay-alias";
    const transaction = path.join(directory, ".transactions", id);
    const stage = path.join(transaction, "stage");
    await mkdir(stage, { recursive: true });
    const first = Buffer.from("first");
    const second = Buffer.from("second");
    await writeFile(path.join(stage, "000000"), first);
    await writeFile(path.join(stage, "000001"), second);
    const journal = {
      protocol: "koni.file-transaction.v1",
      id,
      status: "prepared",
      createdAt: "2026-07-18T00:00:00.000Z",
      writes: [
        {
          path: `value.txt.koni-${id}.tmp`,
          stage: "stage/000000",
          sha256: digestBytes(first),
          sizeBytes: first.byteLength,
        },
        {
          path: "value.txt",
          stage: "stage/000001",
          sha256: digestBytes(second),
          sizeBytes: second.byteLength,
        },
      ],
      deletes: [],
    };
    await writeFile(path.join(transaction, "journal.json"), `${JSON.stringify(journal)}\n`);

    await expect(store.recoverPrepared()).rejects.toMatchObject({
      code: "temporary_path_collision",
    } satisfies Partial<FileJournalError>);
    await expect(stat(path.join(directory, `value.txt.koni-${id}.tmp`))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(path.join(directory, "value.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a hand-authored journal that targets the reserved authority namespace", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    const id = "tx-replay-internal";
    const transaction = path.join(directory, ".transactions", id);
    const stage = path.join(transaction, "stage");
    const bytes = Buffer.from("internal overwrite");
    await mkdir(stage, { recursive: true });
    await writeFile(path.join(stage, "000000"), bytes);
    const journal = {
      protocol: "koni.file-transaction.v1",
      id,
      status: "prepared",
      createdAt: "2026-07-18T00:00:00.000Z",
      writes: [
        {
          path: ".transactions/owned.txt",
          stage: "stage/000000",
          sha256: digestBytes(bytes),
          sizeBytes: bytes.byteLength,
        },
      ],
      deletes: [],
    };
    const journalPath = path.join(transaction, "journal.json");
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`);

    await expect(store.recoverPrepared()).rejects.toMatchObject({ code: "reserved_path" });
    expect(await readFile(path.join(stage, "000000"), "utf8")).toBe("internal overwrite");
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({ status: "prepared" });
    await expect(stat(path.join(directory, ".transactions", "owned.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a hand-authored trailing-slash destination without consuming its stage", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    const id = "tx-replay-trailing";
    const transaction = path.join(directory, ".transactions", id);
    const stage = path.join(transaction, "stage");
    const bytes = Buffer.from("not a leaf");
    await mkdir(stage, { recursive: true });
    await writeFile(path.join(stage, "000000"), bytes);
    const journal = {
      protocol: "koni.file-transaction.v1",
      id,
      status: "prepared",
      createdAt: "2026-07-18T00:00:00.000Z",
      writes: [
        {
          path: "foo/",
          stage: "stage/000000",
          sha256: digestBytes(bytes),
          sizeBytes: bytes.byteLength,
        },
      ],
      deletes: [],
    };
    const journalPath = path.join(transaction, "journal.json");
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`);

    await expect(store.recoverPrepared()).rejects.toMatchObject({ code: "path_shape" });
    expect(await readFile(path.join(stage, "000000"), "utf8")).toBe("not a leaf");
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({ status: "prepared" });
    await expect(stat(path.join(directory, "foo"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["write", "delete"] as const)(
    "rejects a replayed %s whose destination leaf is an existing directory",
    async (kind) => {
      const directory = await root();
      const store = await FileTransactionStore.open(directory);
      const id = `tx-replay-directory-${kind}`;
      const destination = path.join(directory, "existing-directory");
      await mkdir(destination);
      const transaction = path.join(directory, ".transactions", id);
      const bytes = Buffer.from("file bytes");
      if (kind === "write") {
        await mkdir(path.join(transaction, "stage"), { recursive: true });
        await writeFile(path.join(transaction, "stage", "000000"), bytes);
      } else {
        await mkdir(transaction, { recursive: true });
      }
      const journal = {
        protocol: "koni.file-transaction.v1",
        id,
        status: "prepared",
        createdAt: "2026-07-18T00:00:00.000Z",
        writes:
          kind === "write"
            ? [
                {
                  path: "existing-directory",
                  stage: "stage/000000",
                  sha256: digestBytes(bytes),
                  sizeBytes: bytes.byteLength,
                },
              ]
            : [],
        deletes: kind === "delete" ? [{ path: "existing-directory" }] : [],
      };
      const journalPath = path.join(transaction, "journal.json");
      await writeFile(journalPath, `${JSON.stringify(journal)}\n`);

      await expect(store.recoverPrepared()).rejects.toMatchObject({ code: "path_type" });
      expect((await stat(destination)).isDirectory()).toBe(true);
      expect(await readdir(destination)).toEqual([]);
      expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({ status: "prepared" });
      if (kind === "write") {
        expect(await readFile(path.join(transaction, "stage", "000000"), "utf8")).toBe(
          "file bytes",
        );
      }
    },
  );

  it.each([
    { id: "tx-replay-declared-overlap", kind: "declared", code: "path_overlap" },
    { id: "tx-replay-derived-overlap", kind: "derived", code: "temporary_path_collision" },
  ] as const)("rejects a hand-authored $kind path-segment overlap", async ({ id, kind, code }) => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    const transaction = path.join(directory, ".transactions", id);
    const stage = path.join(transaction, "stage");
    const first = Buffer.from("parent");
    const second = Buffer.from("child");
    await mkdir(stage, { recursive: true });
    await writeFile(path.join(stage, "000000"), first);
    await writeFile(path.join(stage, "000001"), second);
    const secondPath = kind === "declared" ? "foo/bar" : `foo.koni-${id}.tmp/bar`;
    const journal = {
      protocol: "koni.file-transaction.v1",
      id,
      status: "prepared",
      createdAt: "2026-07-18T00:00:00.000Z",
      writes: [
        {
          path: "foo",
          stage: "stage/000000",
          sha256: digestBytes(first),
          sizeBytes: first.byteLength,
        },
        {
          path: secondPath,
          stage: "stage/000001",
          sha256: digestBytes(second),
          sizeBytes: second.byteLength,
        },
      ],
      deletes: [],
    };
    await writeFile(path.join(transaction, "journal.json"), `${JSON.stringify(journal)}\n`);

    await expect(store.recoverPrepared()).rejects.toMatchObject({ code });
    expect(await readFile(path.join(stage, "000000"), "utf8")).toBe("parent");
    expect(await readFile(path.join(stage, "000001"), "utf8")).toBe("child");
    await expect(stat(path.join(directory, "foo"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["corrupt", "wrong_size", "symlink"] as const)(
    "rejects a %s stage-to-temporary handoff without mutating its destination",
    async (kind) => {
      const directory = await root();
      const store = await FileTransactionStore.open(directory);
      const id = `tx-temp-${kind}`;
      const destination = path.join(directory, "value.txt");
      await writeFile(destination, "prior");
      await store.prepare(id, [
        {
          path: "value.txt",
          bytes: Buffer.from("next"),
          expectedSha256: digestBytes(Buffer.from("prior")),
        },
      ]);
      const transaction = path.join(directory, ".transactions", id);
      const stage = path.join(transaction, "stage", "000000");
      const temporary = `${destination}.koni-${id}.tmp`;
      await rename(stage, temporary);
      if (kind === "corrupt") {
        await writeFile(temporary, "evil");
      } else if (kind === "wrong_size") {
        await writeFile(temporary, "oversized");
      } else {
        const outside = path.join(directory, "outside.txt");
        await writeFile(outside, "next");
        await unlink(temporary);
        await symlink(outside, temporary);
      }

      const code =
        kind === "corrupt"
          ? "temporary_corrupt"
          : kind === "wrong_size"
            ? "file_size"
            : "file_type";
      await expect(store.commit(id)).rejects.toMatchObject({ code });
      expect(await readFile(destination, "utf8")).toBe("prior");
      expect(
        JSON.parse(await readFile(path.join(transaction, "journal.json"), "utf8")),
      ).toMatchObject({ status: "prepared" });
      await expect(store.recoverPrepared()).rejects.toMatchObject({ code });
      expect(await readFile(destination, "utf8")).toBe("prior");
      expect((await stat(transaction)).isDirectory()).toBe(true);
    },
  );

  it("rejects an exact handoff when the expected destination preimage changed", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    const id = "tx-temp-preimage";
    const destination = path.join(directory, "value.txt");
    await writeFile(destination, "prior");
    await store.prepare(id, [
      {
        path: "value.txt",
        bytes: Buffer.from("next"),
        expectedSha256: digestBytes(Buffer.from("prior")),
      },
    ]);
    const stage = path.join(directory, ".transactions", id, "stage", "000000");
    const temporary = `${destination}.koni-${id}.tmp`;
    await rename(stage, temporary);
    await writeFile(destination, "changed");

    await expect(store.commit(id)).rejects.toMatchObject({ code: "expected_hash" });
    expect(await readFile(destination, "utf8")).toBe("changed");
    expect(await readFile(temporary, "utf8")).toBe("next");
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
          expectedSha256: `sha256:${"0".repeat(64)}`,
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

  it("rejects a pre-existing transaction-root symlink instead of escaping canonical state", async () => {
    const directory = await root();
    const outside = await root();
    await symlink(outside, path.join(directory, ".transactions"));
    await expect(FileTransactionStore.open(directory)).rejects.toMatchObject({
      code: "unsafe_transaction_root",
    } satisfies Partial<FileJournalError>);
    await expect(readFile(path.join(outside, "journal.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects symlinked, non-file, FIFO, and oversized staged bytes through descriptor reads", async () => {
    for (const kind of ["symlink", "directory", "fifo", "oversized"] as const) {
      const directory = await root();
      const store = await FileTransactionStore.open(directory);
      const id = `tx-stage-${kind}`;
      await store.prepare(id, [{ path: "value.txt", bytes: Buffer.from("a") }]);
      const stage = path.join(directory, ".transactions", id, "stage", "000000");
      await unlink(stage);
      if (kind === "symlink") {
        const outside = path.join(directory, "outside.txt");
        await writeFile(outside, "a");
        await symlink(outside, stage);
      } else if (kind === "directory") {
        await mkdir(stage);
      } else if (kind === "fifo") {
        await execFileAsync("mkfifo", [stage]);
      } else {
        await writeFile(stage, "aa");
      }
      await expect(store.commit(id)).rejects.toMatchObject({
        code: kind === "oversized" ? "file_size" : "file_type",
      } satisfies Partial<FileJournalError>);
      await expect(readFile(path.join(directory, "value.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("does not follow a transaction journal symlink during recovery", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    await store.prepare("tx-journal-link", [{ path: "value.txt", bytes: Buffer.from("next") }]);
    const journal = path.join(directory, ".transactions", "tx-journal-link", "journal.json");
    const outside = path.join(directory, "outside-journal.json");
    await writeFile(outside, await readFile(journal));
    await unlink(journal);
    await symlink(outside, journal);
    await expect(store.recoverPrepared()).rejects.toMatchObject({
      code: "file_type",
    } satisfies Partial<FileJournalError>);
    await expect(readFile(path.join(directory, "value.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await stat(path.join(directory, ".transactions", "tx-journal-link"))).isDirectory(),
    ).toBe(true);
  });

  it("streams an existing sparse target larger than the transaction payload bound", async () => {
    const directory = await root();
    const target = path.join(directory, "large.bin");
    await writeFile(target, "x");
    await truncate(target, MAX_TRANSACTION_BYTES + 1);
    const store = await FileTransactionStore.open(directory);
    await store.prepare("tx-large-existing", [{ path: "large.bin", bytes: Buffer.from("small") }]);
    await store.commit("tx-large-existing");
    expect((await stat(target)).size).toBe(5);
    expect(await readFile(target, "utf8")).toBe("small");

    const deleted = path.join(directory, "large-delete.bin");
    await writeFile(deleted, "x");
    await truncate(deleted, MAX_TRANSACTION_BYTES + 1);
    await store.prepare("tx-large-delete", [], [{ path: "large-delete.bin" }]);
    await store.commit("tx-large-delete");
    await expect(stat(deleted)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves every byte untouched when a historical journal exceeds recovery capacity", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    await store.prepare("tx-legacy-capacity", [{ path: "value.txt", bytes: Buffer.from("next") }]);
    const transaction = path.join(directory, ".transactions", "tx-legacy-capacity");
    const journal = path.join(transaction, "journal.json");
    const stage = path.join(transaction, "stage", "000000");
    const destination = path.join(directory, "value.txt");
    await writeFile(destination, "prior");
    const prepared = JSON.parse(await readFile(journal, "utf8")) as Record<string, unknown>;
    const longPrefix = Array.from(
      { length: 16 },
      (_, index) => `${String(index).padStart(2, "0")}-${"x".repeat(240)}`,
    ).join("/");
    prepared.deletes = Array.from({ length: 8_600 }, (_, index) => ({
      path: `${longPrefix}/${String(index).padStart(6, "0")}`,
    }));
    const oversizedCanonicalJournal = Buffer.from(`${JSON.stringify(prepared)}\n`, "utf8");
    expect(oversizedCanonicalJournal.byteLength).toBeGreaterThan(MAX_JOURNAL_BYTES);
    await writeFile(journal, oversizedCanonicalJournal);
    const journalBefore = createHash("sha256").update(oversizedCanonicalJournal).digest("hex");
    const stageBefore = await readFile(stage);
    const destinationBefore = await readFile(destination);
    await expect(store.recoverPrepared()).rejects.toMatchObject({
      code: "legacy_journal_capacity",
    } satisfies Partial<FileJournalError>);
    expect(
      createHash("sha256")
        .update(await readFile(journal))
        .digest("hex"),
    ).toBe(journalBefore);
    expect(await readFile(stage)).toEqual(stageBefore);
    expect(await readFile(destination)).toEqual(destinationBefore);
  });

  it("classifies an empty historical journal as corruption, not legacy capacity", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    await store.prepare("tx-empty-journal", [{ path: "value.txt", bytes: Buffer.from("next") }]);
    const transaction = path.join(directory, ".transactions", "tx-empty-journal");
    const journal = path.join(transaction, "journal.json");
    const stage = path.join(transaction, "stage", "000000");
    const stageBefore = await readFile(stage);
    const unpublishedCopy = await readFile(journal);
    const journalTemp = path.join(transaction, "journal.json.prepare");
    await writeFile(journalTemp, unpublishedCopy);
    await writeFile(path.join(directory, "value.txt"), "prior");
    await truncate(journal, 0);

    await expect(store.recoverPrepared()).rejects.toMatchObject({
      code: "file_size",
    });
    expect((await stat(journal)).size).toBe(0);
    expect(await readFile(journalTemp)).toEqual(unpublishedCopy);
    expect(await readFile(stage)).toEqual(stageBefore);
    expect(await readFile(path.join(directory, "value.txt"), "utf8")).toBe("prior");
  });

  it("uses one conservative case and Unicode identity for every transaction destination", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    for (const [id, left, right] of [
      ["tx-sharp-s", "Straße.txt", "STRASSE.txt"],
      ["tx-sigma", "σ.txt", "ς.txt"],
      ["tx-composed", "café.txt", "cafe\u0301.txt"],
    ] as const) {
      await expect(
        store.prepare(id, [
          { path: left, bytes: Buffer.from("left") },
          { path: right, bytes: Buffer.from("right") },
        ]),
      ).rejects.toMatchObject({ code: "duplicate_path" } satisfies Partial<FileJournalError>);
    }
  });

  it("aligns one maximum run plus state and rejects a larger aggregate before staging", async () => {
    expect(MAX_TRANSACTION_BYTES).toBe(96 * 1024 * 1024);
    const synthetic = (byteLength: number): Uint8Array => ({ byteLength }) as unknown as Uint8Array;
    expect(
      transactionPayloadBytes([
        { bytes: synthetic(MAX_RUN_BYTES) },
        { bytes: synthetic(MAX_STATE_BYTES) },
      ]),
    ).toBe(MAX_TRANSACTION_BYTES);

    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    await expect(
      store.prepare("tx-oversized", [
        {
          path: "oversized.bin",
          bytes: synthetic(MAX_TRANSACTION_BYTES + 1),
        },
      ]),
    ).rejects.toMatchObject({ code: "transaction_size" } satisfies Partial<FileJournalError>);
    await expect(
      readFile(path.join(directory, ".transactions", "tx-oversized")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an oversized declared effect array before touching any element", async () => {
    const directory = await root();
    const store = await FileTransactionStore.open(directory);
    let touched = false;
    const effects = new Proxy([] as Array<{ path: string; bytes: Buffer }>, {
      get(target, property, receiver) {
        if (property === "length") return MAX_TRANSACTION_EFFECTS + 1;
        touched = true;
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(store.prepare("tx-too-many-effects", effects)).rejects.toMatchObject({
      code: "transaction_effects",
    } satisfies Partial<FileJournalError>);
    expect(touched).toBe(false);
  });

  it("bounds global work and drains admitted siblings before propagating the first failure", async () => {
    const semaphore = new AsyncSemaphore(4);
    let active = 0;
    let maximumActive = 0;
    await Promise.all(
      Array.from({ length: 12 }, async () =>
        semaphore.run(async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise<void>((resolve) => setImmediate(resolve));
          active -= 1;
        }),
      ),
    );
    expect(maximumActive).toBe(4);

    let releaseSibling!: () => void;
    const siblingGate = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    let siblingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      siblingStarted = resolve;
    });
    const mapping = mapBoundedDrained(["sibling", "failure", "not-started"], 2, async (value) => {
      if (value === "sibling") {
        siblingStarted();
        await siblingGate;
        return value;
      }
      if (value === "failure") {
        await started;
        throw new Error("first failure");
      }
      throw new Error("bounded mapper admitted work after failure");
    });
    await started;
    let settled = false;
    const observed = mapping.finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseSibling();
    await expect(observed).rejects.toThrow("first failure");
  });
});

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
