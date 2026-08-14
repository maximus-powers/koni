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
    targetBundleSha256: "sha256:058d71d0db00287d3e75fe17e49aaa7624ff378813926c857cf343f8bd9c7242",
  },
  {
    directory: "research-1.0.11",
    bundleSha256: "sha256:1bc8bdb64934ccd475f50acad5b22a7b1b6f7e168a748ecd91e234be76126c60",
    targetDirectory: "research-profile",
    targetBundleSha256: "sha256:03d1433e861762548730679cdc7a8e9d669e0bf9baf287eedd421ad21f05c0b0",
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
