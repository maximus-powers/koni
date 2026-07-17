import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTATIONS = Object.freeze([
  Object.freeze({
    directory: "coding-profile",
    packageName: "@koni/coding-profile",
    packageVersion: "0.7.0",
    profileId: "software",
    profileVersion: "0.7.0",
    lineage: "koni.software",
    fileCount: 46,
    kinds: { config: 18, agent: 10, skill: 18, other: 0 },
    // Frozen oracle plus the reviewed Pi-native resource-policy evolution; never self-regenerated.
    digest: "sha256:2d686e082bbd72a7d866472e979578370dc2d9fe2e5bc1f7a711eeeeacb3a856",
  }),
  Object.freeze({
    directory: "research-profile",
    packageName: "@koni/research-profile",
    packageVersion: "1.0.11",
    profileId: "research",
    profileVersion: "1.0.11",
    lineage: "koni.research",
    fileCount: 49,
    kinds: { config: 17, agent: 13, skill: 18, other: 1 },
    // Frozen oracle plus the reviewed Pi-native resource-policy evolution; never self-regenerated.
    digest: "sha256:596591fd6123dd773100297276deb6c1ea938bf9f9629ef432f4572c26a6fe95",
  }),
]);

function portablePath(path) {
  return path.split(sep).join("/");
}

function classify(path) {
  if (path.startsWith("agents/")) return "agent";
  if (path.startsWith("resources/skills/")) return "skill";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "config";
  return "other";
}

async function walk(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const files = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    const metadata = await lstat(absolute);
    assert.equal(metadata.isSymbolicLink(), false, `bundle contains symlink ${absolute}`);
    if (metadata.isDirectory()) {
      files.push(...(await walk(root, absolute)));
    } else {
      assert.equal(metadata.isFile(), true, `bundle contains non-file ${absolute}`);
      files.push(absolute);
    }
  }
  return files;
}

async function independentInventory(root) {
  const inventory = [];
  for (const absolute of await walk(root)) {
    const bytes = await readFile(absolute);
    const path = portablePath(relative(root, absolute));
    inventory.push({
      path,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size_bytes: bytes.byteLength,
      kind: classify(path),
    });
  }
  inventory.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return inventory;
}

function independentDigest(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.path}\0${file.sha256}\0${file.size_bytes}\0${file.kind}\0`);
  }
  return `sha256:${hash.digest("hex")}`;
}

for (const expected of EXPECTATIONS) {
  test(`${expected.packageName} manifest pins the complete oracle baseline`, async () => {
    const packageRoot = join(repositoryRoot, "packages", expected.directory);
    const manifest = JSON.parse(
      await readFile(join(packageRoot, "koni", "profile-manifest.json"), "utf8"),
    );
    const baselineRoot = join(packageRoot, "koni", "baseline");
    const inventory = await independentInventory(baselineRoot);

    assert.deepEqual(Object.keys(manifest).sort(), [
      "baseline",
      "bundle_sha256",
      "compatibility",
      "package",
      "profile",
      "protocol",
    ]);
    assert.equal(manifest.protocol, "koni.profile-package.v1");
    assert.deepEqual(manifest.package, {
      name: expected.packageName,
      version: expected.packageVersion,
    });
    assert.deepEqual(manifest.profile, {
      id: expected.profileId,
      display_name: expected.profileId === "software" ? "Coding" : "Research",
      version: expected.profileVersion,
      lineage: expected.lineage,
    });
    assert.deepEqual(manifest.compatibility, {
      core_api_range: ">=1.0.0 <2.0.0",
      profile_schema_range: ">=2.0.0 <3.0.0",
      pi_range: ">=0.80.10 <0.81.0",
    });
    assert.equal(manifest.baseline.root, "./baseline");
    assert.deepEqual(manifest.baseline.files, inventory);
    assert.equal(inventory.length, expected.fileCount);
    assert.equal(manifest.bundle_sha256, independentDigest(inventory));
    assert.equal(manifest.bundle_sha256, expected.digest);

    const kinds = { config: 0, agent: 0, skill: 0, prompt: 0, other: 0 };
    for (const file of inventory) kinds[file.kind] += 1;
    assert.deepEqual(kinds, { ...expected.kinds, prompt: 0 });
    assert.equal(
      inventory.some(({ path }) =>
        ["migration-receipt.json", "resource-manifest.json"].includes(path),
      ),
      false,
    );
  });

  test(`${expected.packageName} materializes exactly its manifest inventory`, async () => {
    const packageRoot = join(repositoryRoot, "packages", expected.directory);
    const manifest = JSON.parse(
      await readFile(join(packageRoot, "koni", "profile-manifest.json"), "utf8"),
    );
    const baselineRoot = join(packageRoot, "koni", "baseline");
    const temporaryRoot = await mkdtemp(join(tmpdir(), "koni-profile-materialize-"));
    const destination = join(temporaryRoot, ".koni");
    await cp(baselineRoot, destination, { recursive: true, errorOnExist: true });

    const materialized = await independentInventory(destination);
    assert.deepEqual(materialized, manifest.baseline.files);
    for (const file of materialized) {
      assert.equal(file.path.startsWith("../"), false);
      assert.equal(file.path.startsWith(".managed/"), false);
    }
  });
}

test("official profiles carry the same frozen shared skill resource tree", async () => {
  const coding = await independentInventory(
    join(repositoryRoot, "packages", "coding-profile", "koni", "baseline", "resources", "skills"),
  );
  const research = await independentInventory(
    join(repositoryRoot, "packages", "research-profile", "koni", "baseline", "resources", "skills"),
  );
  assert.equal(coding.length, 18);
  assert.deepEqual(research, coding);
});
