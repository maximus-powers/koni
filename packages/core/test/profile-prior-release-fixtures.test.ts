import path from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ProfilePackageManifest } from "../src/contracts/profile-package.js";
import { loadProfilePackage } from "../src/profile/install.js";

const fixtures = [
  {
    directory: "coding-0.7.0",
    bundleSha256: "sha256:4e955f7fb5a6bbd58542f395471d2e3f1c87364840abd218f973b8f62a5c0c7e",
    targetDirectory: "coding-profile",
    targetBundleSha256: "sha256:305cdb712b5b75d0b678129e3499de483ae49110d4a02d6715e376b33d00c41f",
  },
  {
    directory: "research-1.0.11",
    bundleSha256: "sha256:1bc8bdb64934ccd475f50acad5b22a7b1b6f7e168a748ecd91e234be76126c60",
    targetDirectory: "research-profile",
    targetBundleSha256: "sha256:3713e298a5684f7310ac724af417824072fd7e056323986377a85622dbfd5f74",
  },
] as const;

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

describe("prior profile release fixtures", () => {
  it.each(fixtures)("$directory is the byte-exact authenticated release", async (fixture) => {
    const packageRoot = path.join(
      import.meta.dirname,
      "fixtures",
      "profile-prior-releases",
      fixture.directory,
    );

    const loaded = await loadProfilePackage(packageRoot);

    expect(loaded.manifest.bundle_sha256).toBe(fixture.bundleSha256);
    expect(loaded.manifest.migrations).toBeUndefined();
  });

  it.each(fixtures)("$directory is named exactly once by its target migration", async (fixture) => {
    const manifest = JSON.parse(
      await readFile(
        path.join(
          repositoryRoot,
          "packages",
          fixture.targetDirectory,
          "koni",
          "profile-manifest.json",
        ),
        "utf8",
      ),
    ) as ProfilePackageManifest;

    const matchingMigrations = (manifest.migrations ?? []).filter((migration) =>
      migration.from_bundle_sha256.includes(fixture.bundleSha256),
    );

    expect(manifest.bundle_sha256).toBe(fixture.targetBundleSha256);
    expect(matchingMigrations).toHaveLength(1);
  });
});
