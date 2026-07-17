import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PLACEHOLDER = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const identityPath = path.join(repositoryRoot, "packages/core/dist/runtime/identity.js");
const identityUrl = pathToFileURL(identityPath);
const runtime = await import(`${identityUrl.href}?embed=${randomUUID()}`);
const identity = await runtime.captureCoreRuntimeIdentity(identityUrl);
const source = await readFile(identityPath, "utf8");
const marker = `export const KONI_EMBEDDED_CORE_BUILD_SHA256 = "${PLACEHOLDER}";`;
if (source.split(marker).length !== 2) {
  throw new Error("compiled Core build identity placeholder is missing or ambiguous");
}
const embedded = source.replace(
  marker,
  `export const KONI_EMBEDDED_CORE_BUILD_SHA256 = "${identity.buildSha256}";`,
);
const temporary = `${identityPath}.${randomUUID()}.tmp`;
await writeFile(temporary, embedded, { encoding: "utf8", mode: 0o644, flag: "wx" });
await rename(temporary, identityPath);

const verifiedRuntime = await import(`${identityUrl.href}?verify=${randomUUID()}`);
const verified = await verifiedRuntime.captureCoreRuntimeIdentity(identityUrl);
if (verified.buildSha256 !== identity.buildSha256) {
  throw new Error("embedded Core build identity changed the normalized package digest");
}
if (verifiedRuntime.KONI_EMBEDDED_CORE_BUILD_SHA256 !== identity.buildSha256) {
  throw new Error("compiled Core did not retain its embedded build identity");
}
