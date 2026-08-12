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
    targetBundleSha256: "sha256:d79e2cf553b6326e95d30ed5fa38f805fbb79ce2a78d23ced318a7b202bb6d48",
  },
  {
    directory: "research-1.0.11",
    bundleSha256: "sha256:1bc8bdb64934ccd475f50acad5b22a7b1b6f7e168a748ecd91e234be76126c60",
    targetDirectory: "research-profile",
    targetBundleSha256: "sha256:138b83fe05230ead65d20695c0eb19fda38ea251ea9d43b07f20a6b680b7f498",
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
