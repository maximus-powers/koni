import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertStandaloneBundle } from "./artifact-policy.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = resolve(packageRoot, "dist/koni-pi-host.mjs");
const checksumPath = resolve(packageRoot, "dist/koni-pi-host.sha256");

const checksum = await readFile(checksumPath, "utf8");
const match = /^([0-9a-f]{64})(?:[ \t]+\*?koni-pi-host\.mjs)?\r?\n?$/u.exec(checksum);
if (!match) throw new Error("dist/koni-pi-host.sha256 has an invalid or non-canonical format");

const expected = match[1];
const bundle = await readFile(bundlePath);
assertStandaloneBundle(bundle.toString("utf8"));
const actual = createHash("sha256").update(bundle).digest("hex");
if (actual !== expected) {
  throw new Error(`Koni Pi host artifact checksum mismatch: expected ${expected}, received ${actual}`);
}

process.stdout.write(`verified dist/koni-pi-host.mjs sha256 ${actual}\n`);
