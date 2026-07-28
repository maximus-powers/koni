import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileAtomicallyNoReplace } from "../src/pi/atomic-file.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

describe("atomic no-replace persistence", () => {
  it("publishes complete private bytes and never replaces an existing destination", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koni-atomic-file-"));
    temporary.push(root);
    const destination = path.join(root, "state.jsonl");

    await expect(createFileAtomicallyNoReplace(destination, "first\n", 0o400)).resolves.toBe(true);
    expect(await readFile(destination, "utf8")).toBe("first\n");
    expect((await stat(destination)).mode & 0o777).toBe(0o400);

    await expect(createFileAtomicallyNoReplace(destination, "second\n", 0o600)).resolves.toBe(
      false,
    );
    expect(await readFile(destination, "utf8")).toBe("first\n");
    expect((await stat(destination)).mode & 0o777).toBe(0o400);
  });

  it("does not alter a pre-existing file even when its bytes are unrelated", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "koni-atomic-existing-"));
    temporary.push(root);
    const destination = path.join(root, "receipt.json");
    await writeFile(destination, "authority-owned", { mode: 0o600 });

    await expect(createFileAtomicallyNoReplace(destination, "attempt", 0o400)).resolves.toBe(false);
    expect(await readFile(destination, "utf8")).toBe("authority-owned");
  });
});
